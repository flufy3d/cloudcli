/**
 * OpenCode Run Registry
 *
 * Bookkeeping for chat runs in flight against the service: which app
 * session maps to which provider session, the per-run event translator,
 * first-settlement-wins outcome tracking, event dispatch, and the
 * reconciliation that rescues a run whose terminal event was lost during a
 * stream drop (the session row's `time.idle`/`outcome`, verified live
 * against v2.0.31, say whether it already finished).
 *
 * @module opencode-run-registry
 */

import type {
  ActiveBackgroundTask,
  BackgroundTaskSummary,
  ProviderRuntimeWriter,
  ProviderTokenUsageResult,
} from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { OpenCodeApiError, type OpenCodeApiClient, type OpenCodeSessionSnapshot } from './opencode-api.client.js';
import {
  buildOpenCodeTokenBudget,
  readOpenCodeStepTokens,
  resolveOpenCodeContextWindow,
  type OpenCodeStepTokens,
} from './opencode-context-usage.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import { OpenCodeSessionEventTranslator, type OpenCodeRunOutcome } from './opencode-event-translator.js';
import { OpenCodeSubagentIndex } from './opencode-subagent-index.js';

const PROVIDER = 'opencode' as const;
const MIN_BUDGET_FRAME_INTERVAL_MS = 1500;
/**
 * How long a completed run's bookkeeping is kept alive for a child session
 * that never reported a terminal. The engine reports one on its own, so this
 * only backstops a lost stream — without it the runtime would wait forever.
 */
const BACKGROUND_WORK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Live context-occupancy publisher for one opencode run.
 *
 * `session.step.ended` carries the step's own token usage (see
 * `opencode-context-usage.ts` for why the session columns cannot stand in),
 * and every report may emit a `token_budget` frame. Frames are deduplicated by
 * value and floored at 1.5s apart, the same contract zcode's live refresher
 * uses, so a long tool loop does not spam the composer with repaints.
 *
 * The window is resolved once at construction from the run's model reference;
 * a model the cache does not know simply yields windowless frames (no
 * percentage) rather than guessing one.
 *
 * Consumer: opencode runtime (`createOpenCodeRuntime`).
 */
export class OpenCodeTokenBudgetTracker {
  private readonly contextWindow: number | undefined;
  private lastSentAt = 0;
  private lastSentUsed: number | null = null;

  constructor(providerId: string | null, modelId: string | null) {
    this.contextWindow = providerId && modelId
      ? resolveOpenCodeContextWindow(providerId, modelId)
      : undefined;
  }

  /** Live frame from a step event's tokens; throttled by value and time. */
  report(tokens: OpenCodeStepTokens, writer: ProviderRuntimeWriter, appSessionId: string): void {
    this.emit(buildOpenCodeTokenBudget(tokens, this.contextWindow), writer, appSessionId);
  }

  /** Publishes one frame, applying the throttle. Public so the runtime can push the authoritative end-of-run reading. */
  emit(budget: ProviderTokenUsageResult, writer: ProviderRuntimeWriter, appSessionId: string): void {
    if (this.lastSentUsed === budget.used && Date.now() - this.lastSentAt < MIN_BUDGET_FRAME_INTERVAL_MS) {
      return;
    }

    this.lastSentUsed = budget.used;
    this.lastSentAt = Date.now();
    writer.send(createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      sessionId: appSessionId,
      provider: PROVIDER,
      kind: 'status',
      text: 'token_budget',
      tokenBudget: budget,
    }));
  }
}

/** How a run ended: an engine outcome, or `lost` when the service/session vanished under it. */
export type OpenCodeRunSettlement =
  | OpenCodeRunOutcome
  | { outcome: 'lost'; error: string };

/**
 * One chat run in flight.
 *
 * Consumer: opencode runtime (orchestration) via the registry.
 */
export type OpenCodeActiveRun = {
  appSessionId: string;
  providerSessionId: string;
  writer: ProviderRuntimeWriter;
  translator: OpenCodeSessionEventTranslator;
  /**
   * What the run was asked to do: an ordinary turn, or a `/compact`. A
   * compaction the user asked for must report its own failure, while the
   * engine compacting a normal turn's context on its own must not fail that
   * turn — see `dispatch`.
   */
  purpose: 'chat' | 'compact';
  /** Epoch ms right before the prompt was posted; `time.idle` at or after it means the run finished. */
  startedAt: number;
  aborted: boolean;
  /** Set once the prompt was accepted; only then can reconciliation judge the run. */
  promptAccepted: boolean;
  /** Resolves on the first settlement; later settlements are ignored. */
  settled: Promise<OpenCodeRunSettlement>;
  settle: (settlement: OpenCodeRunSettlement) => void;
};

/**
 * Tracks the runs of one runtime instance.
 *
 * Consumer: opencode runtime.
 */
export class OpenCodeRunRegistry {
  private readonly byApp = new Map<string, OpenCodeActiveRun>();
  private readonly byProvider = new Map<string, OpenCodeActiveRun>();
  /** Child session → spawning run links, learned from session lifecycle events. */
  private readonly subagents = new OpenCodeSubagentIndex();
  /** Child events that arrived before their parent tool call was identifiable. */
  private readonly deferredChildEvents = new Map<string, OpenCodeEventEnvelope[]>();
  /**
   * Background child sessions still running per app session, and the writer
   * that carries their status frames. They outlive the parent turn — a
   * completed run is kept registered while this map names its session, so the
   * composer can show the work and the child can still ask a question.
   */
  private readonly backgroundByApp = new Map<string, Map<string, BackgroundTaskSummary>>();
  private readonly backgroundWriterByApp = new Map<string, ProviderRuntimeWriter>();
  private readonly backgroundAppByChild = new Map<string, string>();
  /** Resolvers waiting for one app session's background work to clear. */
  private readonly backgroundClearWaiters = new Map<string, Set<() => void>>();

  create(
    appSessionId: string,
    providerSessionId: string,
    writer: ProviderRuntimeWriter,
    purpose: OpenCodeActiveRun['purpose'] = 'chat',
  ): OpenCodeActiveRun {
    let settle!: (settlement: OpenCodeRunSettlement) => void;
    const settled = new Promise<OpenCodeRunSettlement>((resolve) => {
      settle = resolve;
    });
    const run: OpenCodeActiveRun = {
      appSessionId,
      providerSessionId,
      writer,
      translator: new OpenCodeSessionEventTranslator(appSessionId),
      purpose,
      startedAt: Date.now(),
      aborted: false,
      promptAccepted: false,
      settled,
      settle,
    };
    this.byApp.set(appSessionId, run);
    this.byProvider.set(providerSessionId, run);
    return run;
  }

  /** Looks a run up by either the app session id or the provider session id. */
  get(sessionId: string): OpenCodeActiveRun | null {
    return this.byApp.get(sessionId) ?? this.byProvider.get(sessionId) ?? null;
  }

  all(): OpenCodeActiveRun[] {
    return [...this.byApp.values()];
  }

  release(run: OpenCodeActiveRun): void {
    if (this.byApp.get(run.appSessionId) === run) {
      this.byApp.delete(run.appSessionId);
    }
    if (this.byProvider.get(run.providerSessionId) === run) {
      this.byProvider.delete(run.providerSessionId);
      for (const childSessionId of this.deferredChildEvents.keys()) {
        if (this.subagents.resolve(childSessionId)?.parentProviderSessionId === run.providerSessionId) {
          this.deferredChildEvents.delete(childSessionId);
        }
      }
      this.subagents.forgetParent(run.providerSessionId);
    }
  }

  settleAll(settlement: OpenCodeRunSettlement): void {
    for (const run of this.all()) {
      run.settle(settlement);
    }
    this.clearBackgroundWork();
  }

  /** The active children of one app session, in the wire shape the composer ack uses. */
  backgroundTasksFor(appSessionId: string): ActiveBackgroundTask[] {
    return [...(this.backgroundByApp.get(appSessionId)?.values() ?? [])].map((task) => ({
      // The card's identity is the spawn call, not the child session: the
      // transcript anchors its card by the call and `chat.stop-task` is keyed
      // by the tool-use id the client compares against, so one handle on the
      // strip both reveals the card and stops exactly this task. The child
      // session id is only the engine's stop handle (`taskId`).
      id: task.toolUseId || task.taskId,
      taskId: task.taskId,
      toolName: 'subagent',
      description: task.description,
      startedAt: task.startedAt,
    }));
  }

  /** True while a child session of this app session still runs. */
  isBackgroundWorkPending(appSessionId: string): boolean {
    return this.backgroundByApp.has(appSessionId);
  }

  /** The same children in the shape the running-sessions list consumes. */
  listBackgroundWork(): Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> {
    return [...this.backgroundByApp].map(([sessionId, tasks]) => ({
      sessionId,
      tasks: [...tasks.values()],
    }));
  }

  /**
   * Resolves once every child of this app session has settled, or after the
   * timeout that backstops a lost terminal. Consumer: the runtime, which keeps
   * the run's writer/bridge alive for that long after the parent turn ends.
   */
  whenBackgroundWorkClears(
    appSessionId: string,
    timeoutMs: number = BACKGROUND_WORK_TIMEOUT_MS,
  ): Promise<void> {
    if (!this.backgroundByApp.has(appSessionId)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.clearBackgroundWorkForSession(appSessionId);
        done();
      }, timeoutMs);
      timer.unref?.();
      let waiters = this.backgroundClearWaiters.get(appSessionId);
      if (!waiters) {
        waiters = new Set();
        this.backgroundClearWaiters.set(appSessionId, waiters);
      }
      waiters.add(done);
    });
  }

  /**
   * Routes one service event to the run that owns its session: frames to the
   * writer, step occupancy to the budget tracker when one is registered, and
   * terminals to settle.
   *
   * A `session.compaction.failed` is the run's own failure only when the run
   * asked for it: an explicit `/compact` has nothing else to report it
   * through, while a normal turn that auto-compacted carries on — the engine
   * reports that turn's outcome separately, and a compaction it decided to run
   * must not fail the user's turn.
   */
  dispatch(event: OpenCodeEventEnvelope, budgetTracker?: OpenCodeTokenBudgetTracker): void {
    this.subagents.note(event);
    const data = readObjectRecord(event.data) ?? {};
    const providerSessionId = readOptionalString(data.sessionID);
    if (!providerSessionId) {
      return;
    }

    const isChildTerminal = event.type === 'session.execution.succeeded'
      || event.type === 'session.execution.failed'
      || event.type === 'session.execution.interrupted';
    if (isChildTerminal) {
      // No-ops for the parent; this is the child's own terminal, which must
      // clear its background entry even when the parent run is already gone.
      this.finishBackgroundWork(providerSessionId);
    }

    // A child session's events belong to the run that spawned it, not to a
    // run of their own: their frames are stamped with the spawn call id so
    // the transcript folds them into the subagent container. Step occupancy
    // and terminals stay with the child — the parent turn is settled by its
    // own execution events.
    const parent = this.subagents.resolve(providerSessionId);
    if (parent) {
      const run = this.byProvider.get(parent.parentProviderSessionId);
      if (!run) {
        this.deferredChildEvents.delete(providerSessionId);
        return;
      }
      if (!parent.parentToolCallId) {
        // The link exists but its launch call is still being resolved; hold
        // the frames rather than leaking them to the top level untagged.
        const queue = this.deferredChildEvents.get(providerSessionId) ?? [];
        queue.push(event);
        this.deferredChildEvents.set(providerSessionId, queue);
        return;
      }
      const deferred = this.deferredChildEvents.get(providerSessionId);
      if (deferred) {
        this.deferredChildEvents.delete(providerSessionId);
        for (const queued of deferred) {
          const queuedTerminal = queued.type === 'session.execution.succeeded'
            || queued.type === 'session.execution.failed'
            || queued.type === 'session.execution.interrupted';
          if (!queuedTerminal) {
            this.startBackgroundWork(run, providerSessionId, readObjectRecord(queued.data) ?? {});
          }
          this.deliverChildEvent(queued, run, parent.parentToolCallId);
        }
      }
      if (!isChildTerminal) {
        // The first delivered event of a child is its `session.created` (or
        // the queued head once the launch call resolved): that is the
        // title/agent the composer names the background work with.
        this.startBackgroundWork(run, providerSessionId, data);
      }
      this.deliverChildEvent(event, run, parent.parentToolCallId);
      return;
    }

    const run = this.byProvider.get(providerSessionId);
    if (!run) {
      return;
    }
    this.deliverEvent(event, run, budgetTracker);
  }

  /** Forwards a child session's translated frames under its spawn call id. */
  private deliverChildEvent(
    event: OpenCodeEventEnvelope,
    run: OpenCodeActiveRun,
    parentToolUseId: string,
  ): void {
    const { frames } = run.translator.translate(event);
    for (const frame of frames) {
      run.writer.send({ ...frame, parentToolUseId });
    }
  }

  /**
   * Records a child session as background work of its parent's app session.
   *
   * A subagent outlives the parent turn: the composer must keep showing the
   * purple background pill after `complete`, and `chat.subscribe`/the
   * running-sessions poll read the same list. One entry per child.
   */
  private startBackgroundWork(
    run: OpenCodeActiveRun,
    childSessionId: string,
    data: Record<string, unknown>,
  ): void {
    if (this.backgroundAppByChild.has(childSessionId)) {
      return;
    }
    let tasks = this.backgroundByApp.get(run.appSessionId);
    if (!tasks) {
      tasks = new Map();
      this.backgroundByApp.set(run.appSessionId, tasks);
    }
    tasks.set(childSessionId, {
      taskId: childSessionId,
      toolUseId: this.subagents.resolve(childSessionId)?.parentToolCallId ?? '',
      taskType: 'local_agent',
      description: readOptionalString(data.title) ?? readOptionalString(data.agent) ?? childSessionId,
      startedAt: Date.now(),
    });
    this.backgroundAppByChild.set(childSessionId, run.appSessionId);
    this.backgroundWriterByApp.set(run.appSessionId, run.writer);
    this.broadcastBackgroundWork(run.appSessionId);
  }

  /** Drops a child from its parent's background list and tells the composer. */
  private finishBackgroundWork(childSessionId: string): void {
    const appSessionId = this.backgroundAppByChild.get(childSessionId);
    if (!appSessionId) {
      return;
    }
    this.backgroundAppByChild.delete(childSessionId);
    const tasks = this.backgroundByApp.get(appSessionId);
    tasks?.delete(childSessionId);

    const writer = this.backgroundWriterByApp.get(appSessionId);
    if (!tasks || tasks.size === 0) {
      this.backgroundByApp.delete(appSessionId);
      this.backgroundWriterByApp.delete(appSessionId);
      this.resolveBackgroundWaiters(appSessionId);
    }
    writer?.send(createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      sessionId: appSessionId,
      provider: PROVIDER,
      kind: 'status',
      text: 'background_tasks',
      backgroundTasks: this.backgroundTasksFor(appSessionId),
      backgroundWorkPending: this.backgroundByApp.has(appSessionId),
    }));
  }

  /** Publishes the current child list so the composer pill appears/clears live. */
  private broadcastBackgroundWork(appSessionId: string): void {
    this.backgroundWriterByApp.get(appSessionId)?.send(createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      sessionId: appSessionId,
      provider: PROVIDER,
      kind: 'status',
      text: 'background_tasks',
      backgroundTasks: this.backgroundTasksFor(appSessionId),
      backgroundWorkPending: this.backgroundByApp.has(appSessionId),
    }));
  }

  private clearBackgroundWorkForSession(appSessionId: string): void {
    for (const [childSessionId, parentAppSessionId] of this.backgroundAppByChild) {
      if (parentAppSessionId === appSessionId) {
        this.backgroundAppByChild.delete(childSessionId);
      }
    }
    this.backgroundByApp.delete(appSessionId);
    this.backgroundWriterByApp.delete(appSessionId);
    this.resolveBackgroundWaiters(appSessionId);
  }

  private clearBackgroundWork(): void {
    for (const appSessionId of [...this.backgroundByApp.keys()]) {
      this.clearBackgroundWorkForSession(appSessionId);
    }
    this.backgroundAppByChild.clear();
    this.backgroundWriterByApp.clear();
  }

  private resolveBackgroundWaiters(appSessionId: string): void {
    const waiters = this.backgroundClearWaiters.get(appSessionId);
    if (!waiters) {
      return;
    }
    this.backgroundClearWaiters.delete(appSessionId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /** Forwards a run's own event: frames, occupancy, and terminals. */
  private deliverEvent(
    event: OpenCodeEventEnvelope,
    run: OpenCodeActiveRun,
    budgetTracker?: OpenCodeTokenBudgetTracker,
  ): void {
    const { frames, terminal, stepTokens, compactionError } = run.translator.translate(event);
    for (const frame of frames) {
      run.writer.send(frame);
    }
    if (stepTokens && budgetTracker) {
      budgetTracker.report(stepTokens, run.writer, run.appSessionId);
    }
    if (compactionError && run.purpose === 'compact') {
      run.settle({ outcome: 'failed', error: compactionError });
      return;
    }
    if (terminal) {
      run.settle(terminal);
    }
  }

  /**
   * After a stream drop the terminal event may have been missed. A session
   * that went idle after the prompt was posted has finished; a 404 means it
   * is gone for good; any other failure leaves the run open for the next
   * reconnect.
   */
  async reconcile(client: Pick<OpenCodeApiClient, 'getSession'>): Promise<void> {
    for (const run of this.all()) {
      if (!run.promptAccepted) {
        continue;
      }
      try {
        const snapshot = await client.getSession(run.providerSessionId);
        if (snapshot.idleAt !== null && snapshot.idleAt >= run.startedAt) {
          run.settle(settlementFromSnapshot(snapshot));
        }
      } catch (error) {
        if (error instanceof OpenCodeApiError && error.status === 404) {
          run.settle({ outcome: 'lost', error: 'The OpenCode session no longer exists.' });
        }
      }
    }
  }
}

function settlementFromSnapshot(snapshot: OpenCodeSessionSnapshot): OpenCodeRunSettlement {
  if (snapshot.outcome === 'interrupted') {
    return { outcome: 'interrupted', reason: 'reconciled after a stream drop' };
  }
  if (snapshot.outcome === 'failed') {
    return { outcome: 'failed', error: 'The run failed while the event stream was disconnected.' };
  }
  return { outcome: 'succeeded' };
}

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

import type { ProviderRuntimeWriter, ProviderTokenUsageResult } from '@/shared/types.js';
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

const PROVIDER = 'opencode' as const;
const MIN_BUDGET_FRAME_INTERVAL_MS = 1500;

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

  create(appSessionId: string, providerSessionId: string, writer: ProviderRuntimeWriter): OpenCodeActiveRun {
    let settle!: (settlement: OpenCodeRunSettlement) => void;
    const settled = new Promise<OpenCodeRunSettlement>((resolve) => {
      settle = resolve;
    });
    const run: OpenCodeActiveRun = {
      appSessionId,
      providerSessionId,
      writer,
      translator: new OpenCodeSessionEventTranslator(appSessionId),
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
    }
  }

  settleAll(settlement: OpenCodeRunSettlement): void {
    for (const run of this.all()) {
      run.settle(settlement);
    }
  }

  /**
   * Routes one service event to the run that owns its session: frames to the
   * writer, step occupancy to the budget tracker when one is registered, and
   * terminals to settle.
   */
  dispatch(event: OpenCodeEventEnvelope, budgetTracker?: OpenCodeTokenBudgetTracker): void {
    const providerSessionId = readOptionalString(readObjectRecord(event.data)?.sessionID);
    const run = providerSessionId ? this.byProvider.get(providerSessionId) : null;
    if (!run) {
      return;
    }
    const { frames, terminal, stepTokens } = run.translator.translate(event);
    for (const frame of frames) {
      run.writer.send(frame);
    }
    if (stepTokens && budgetTracker) {
      budgetTracker.report(stepTokens, run.writer, run.appSessionId);
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

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

import type { NormalizedMessage, ProviderRuntimeWriter } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { OpenCodeApiError, type OpenCodeApiClient, type OpenCodeSessionSnapshot } from './opencode-api.client.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import { OpenCodeSessionEventTranslator, type OpenCodeRunOutcome, type OpenCodeToolCall } from './opencode-event-translator.js';

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

/** Session token totals → the status-frame budget shape other providers emit. */
export function toOpenCodeTokenBudget(
  tokens: NonNullable<OpenCodeSessionSnapshot['tokens']>,
): { used: number; inputTokens: number; outputTokens: number; breakdown: { input: number; output: number } } | null {
  const used = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
  if (used <= 0) {
    return null;
  }
  const inputTokens = tokens.input + tokens.cacheRead;
  return {
    used,
    inputTokens,
    outputTokens: tokens.output,
    breakdown: { input: inputTokens, output: tokens.output },
  };
}

/**
 * A session the engine created for a subagent, owned by the run that spawned
 * it. Requests and events of such a session carry its own id, so without this
 * record they match no run and are dropped: an approval card never appears and
 * the subagent's steps never show.
 */
type OpenCodeChildSession = {
  run: OpenCodeActiveRun;
  /** The session that spawned this one (the root session, or another child). */
  parentSessionId: string;
  /**
   * The call in the parent session that spawned this one, as the latest
   * `session.tool.progress` named it (a resumed child is spawned again by a
   * later call, and the newest call owns the card). The card the user sees is
   * the one of the topmost child of the root run, so a grandchild finds its
   * card by walking up (`cardCallIdOf`). Unknown until the call reports it.
   */
  spawnCallId?: string;
  translator: OpenCodeSessionEventTranslator;
  /** Frames translated before the card was known, flushed once it is. */
  held: NormalizedMessage[];
  /** Set once the held-frame cap was hit, so the loss is logged once per child. */
  heldOverflowLogged?: boolean;
};

/** Most frames held for a child whose card is not known yet. */
const MAX_HELD_CHILD_FRAMES = 500;

/** Longest ancestor chain followed; a real tree is a few levels deep, a cycle is a bug. */
const MAX_CHILD_DEPTH = 16;

/** Frame kinds a child's stream never contributes: its finished rows carry the content. */
const CHILD_STREAMING_KINDS = new Set(['stream_delta', 'stream_end']);

/**
 * Tracks the runs of one runtime instance.
 *
 * Consumer: opencode runtime.
 */
export class OpenCodeRunRegistry {
  private readonly byApp = new Map<string, OpenCodeActiveRun>();
  private readonly byProvider = new Map<string, OpenCodeActiveRun>();
  private readonly children = new Map<string, OpenCodeChildSession>();

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

  /**
   * The root run's provider session and the child's tool-call lookup, for a
   * session the engine created for a subagent. Used by the interaction bridge
   * to show a child's approval and question cards under the root session.
   */
  childOwner(sessionId: string): {
    rootProviderSessionId: string;
    resolveToolCall: (callId: string) => OpenCodeToolCall | null;
    /** The `Agent` card the child's requests belong to, when its spawn call is known. */
    resolveOrigin: () => { toolUseId: string; description?: string } | null;
  } | null {
    const child = this.children.get(sessionId);
    if (!child) {
      return null;
    }
    return {
      rootProviderSessionId: child.run.providerSessionId,
      resolveToolCall: (callId) => child.translator.getToolCall(callId),
      resolveOrigin: () => {
        const toolUseId = this.cardCallIdOf(child);
        if (!toolUseId) {
          return null;
        }
        const description = readOptionalString(readObjectRecord(child.run.translator.getToolCall(toolUseId)?.input)?.description);
        return { toolUseId, ...(description ? { description } : {}) };
      },
    };
  }

  /**
   * Settles the cards of calls a run's children never resolved. Called when
   * the run ends, alongside the root translator's own settle.
   */
  settleChildren(run: OpenCodeActiveRun): NormalizedMessage[] {
    const frames: NormalizedMessage[] = [];
    for (const child of this.children.values()) {
      if (child.run === run) {
        frames.push(...child.translator.settleOpenSubagents());
      }
    }
    return frames;
  }

  release(run: OpenCodeActiveRun): void {
    for (const [sessionId, child] of this.children) {
      if (child.run === run) {
        this.children.delete(sessionId);
      }
    }
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

  /** Routes one service event to the run that owns its session: frames to the writer, terminals to settle. */
  dispatch(event: OpenCodeEventEnvelope): void {
    const data = readObjectRecord(event.data);
    const providerSessionId = readOptionalString(data?.sessionID);
    this.learnOwnership(event, providerSessionId, data);
    const run = providerSessionId ? this.byProvider.get(providerSessionId) : null;
    if (!run) {
      const child = providerSessionId ? this.children.get(providerSessionId) : undefined;
      if (child) {
        this.dispatchChild(child, event);
      }
      return;
    }
    const { frames, terminal } = run.translator.translate(event);
    for (const frame of frames) {
      run.writer.send(frame);
    }
    if (terminal) {
      run.settle(terminal);
    }
  }

  /**
   * Learns which sessions belong to a run: `session.created` names a child's
   * parent, and a spawn call's `session.tool.progress` names the child it
   * started (`metadata.sessionID`) and the call that owns its card.
   */
  private learnOwnership(event: OpenCodeEventEnvelope, sessionId: string | undefined, data: Record<string, unknown> | null): void {
    if (!sessionId || !data) {
      return;
    }
    if (event.type === 'session.created') {
      const parentId = readOptionalString(data.parentID);
      if (parentId && !this.children.has(sessionId)) {
        this.adoptChild(sessionId, parentId);
      }
      return;
    }
    if (event.type === 'session.tool.progress') {
      const childId = readOptionalString(readObjectRecord(data.metadata)?.sessionID);
      const callId = readOptionalString(data.id);
      if (!childId || !callId) {
        return;
      }
      const child = this.children.get(childId) ?? this.adoptChild(childId, sessionId);
      if (child && child.spawnCallId !== callId) {
        child.spawnCallId = callId;
        this.flushHeldBelow(childId);
      }
    }
  }

  /**
   * The root-level `Agent` call whose card shows a child's steps: the spawn
   * call of the topmost child on its ancestor chain. Resolved at dispatch time
   * rather than copied at adoption, because a grandchild can be adopted before
   * the call that spawned its ancestor has been reported.
   */
  private cardCallIdOf(child: OpenCodeChildSession): string | undefined {
    let current = child;
    for (let depth = 0; depth < MAX_CHILD_DEPTH; depth += 1) {
      const parent = this.children.get(current.parentSessionId);
      if (!parent) {
        return current.spawnCallId;
      }
      current = parent;
    }
    return undefined;
  }

  private adoptChild(childId: string, parentId: string): OpenCodeChildSession | null {
    const rootRun = this.byProvider.get(parentId);
    const parentChild = rootRun ? undefined : this.children.get(parentId);
    const run = rootRun ?? parentChild?.run;
    if (!run) {
      return null;
    }
    const child: OpenCodeChildSession = {
      run,
      parentSessionId: parentId,
      translator: new OpenCodeSessionEventTranslator(run.appSessionId),
      held: [],
    };
    this.children.set(childId, child);
    return child;
  }

  private dispatchChild(child: OpenCodeChildSession, event: OpenCodeEventEnvelope): void {
    // A child's own end is not the run's end: only the root session settles it.
    const { frames } = child.translator.translate(event);
    const cardCallId = this.cardCallIdOf(child);
    for (const frame of frames) {
      if (CHILD_STREAMING_KINDS.has(frame.kind)) {
        continue;
      }
      if (cardCallId === undefined) {
        if (child.held.length < MAX_HELD_CHILD_FRAMES) {
          child.held.push(frame);
        } else if (!child.heldOverflowLogged) {
          child.heldOverflowLogged = true;
          console.warn(
            `[OpenCode] dropping steps of a subagent session whose card is still unknown (more than ${MAX_HELD_CHILD_FRAMES} held)`,
          );
        }
        continue;
      }
      child.run.writer.send(this.tieToCard(frame, cardCallId));
    }
  }

  /** Sends what a child (and every session below it) held while its card was unknown. */
  private flushHeldBelow(rootChildId: string): void {
    for (const [childId, child] of this.children) {
      if (child.held.length === 0) {
        continue;
      }
      if (childId !== rootChildId && !this.isBelow(childId, rootChildId)) {
        continue;
      }
      const cardCallId = this.cardCallIdOf(child);
      if (cardCallId === undefined) {
        continue;
      }
      for (const frame of child.held) {
        child.run.writer.send(this.tieToCard(frame, cardCallId));
      }
      child.held = [];
    }
  }

  private isBelow(childId: string, ancestorId: string): boolean {
    let current = this.children.get(childId);
    for (let depth = 0; current && depth < MAX_CHILD_DEPTH; depth += 1) {
      if (current.parentSessionId === ancestorId) {
        return true;
      }
      current = this.children.get(current.parentSessionId);
    }
    return false;
  }

  /** Marks a child's row as belonging to the card of `callId`. */
  private tieToCard(frame: NormalizedMessage, callId: string): NormalizedMessage {
    return { ...frame, parentToolUseId: callId };
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

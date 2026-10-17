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

import type { ProviderRuntimeWriter } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { OpenCodeApiError, type OpenCodeApiClient, type OpenCodeSessionSnapshot } from './opencode-api.client.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import { OpenCodeSessionEventTranslator, type OpenCodeRunOutcome } from './opencode-event-translator.js';

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

  /** Routes one service event to the run that owns its session: frames to the writer, terminals to settle. */
  dispatch(event: OpenCodeEventEnvelope): void {
    const providerSessionId = readOptionalString(readObjectRecord(event.data)?.sessionID);
    const run = providerSessionId ? this.byProvider.get(providerSessionId) : null;
    if (!run) {
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

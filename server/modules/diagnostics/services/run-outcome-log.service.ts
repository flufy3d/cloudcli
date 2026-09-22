import type { LLMProvider, RunOutcome, RunOutcomeReason } from '@/shared/types.js';

/**
 * How many finished runs to keep. One entry is a few hundred bytes, and the
 * window only has to be long enough that a user who notices "it disconnected"
 * minutes later still finds the run in it.
 */
const MAX_RECORDED_OUTCOMES = 100;

/** Newest last, so recording is a push and eviction is a shift. */
const outcomes: RunOutcome[] = [];

/**
 * Records why one run ended.
 *
 * Consumers: the websocket module's run registry, which is the single place
 * every run — completed, aborted, or failed — passes through on its way out.
 *
 * Also written to the process log, because the two questions this answers
 * ("did the client abort it?" / "did the engine die?") are usually asked
 * about a run that ended before anyone thought to export a report.
 */
export function recordRunOutcome(input: {
  sessionId: string;
  provider: LLMProvider;
  reason: RunOutcomeReason;
  exitCode: number;
  /** Epoch milliseconds, as the registry tracks them. */
  startedAt: number;
  endedAt: number;
  eventCount: number;
  lastSeq: number;
}): void {
  const outcome: RunOutcome = {
    sessionId: input.sessionId,
    provider: input.provider,
    reason: input.reason,
    exitCode: input.exitCode,
    startedAtIso: new Date(input.startedAt).toISOString(),
    endedAtIso: new Date(input.endedAt).toISOString(),
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    eventCount: input.eventCount,
    lastSeq: input.lastSeq,
  };

  outcomes.push(outcome);
  if (outcomes.length > MAX_RECORDED_OUTCOMES) {
    outcomes.splice(0, outcomes.length - MAX_RECORDED_OUTCOMES);
  }

  console.log(
    `[RunOutcome] ${outcome.provider} session=${outcome.sessionId} reason=${outcome.reason} `
    + `exit=${outcome.exitCode} duration=${outcome.durationMs}ms events=${outcome.eventCount}`,
  );
}

/**
 * Returns the recorded outcomes, newest first.
 *
 * Consumers: the diagnostics route, which serves them to the settings export.
 * A `limit` outside the retained range is ignored rather than rejected — this
 * is a diagnostics read, and returning everything is always a valid answer.
 */
export function readRunOutcomes(limit?: number): RunOutcome[] {
  const newestFirst = [...outcomes].reverse();
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return newestFirst;
  }
  return newestFirst.slice(0, Math.min(limit, newestFirst.length));
}

/**
 * Empties the log.
 *
 * Consumers: the diagnostics tests, and the diagnostics route's reset path so
 * a user can start a clean capture before reproducing a problem.
 */
export function clearRunOutcomes(): void {
  outcomes.length = 0;
}

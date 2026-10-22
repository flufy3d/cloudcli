/**
 * The identity of a Codex turn that ended in failure.
 * ========================================================
 *
 * Codex reports a failed turn through two channels that must agree: the live
 * `app-server` sends an `error` notification and a `turn/completed` whose
 * status is `failed`, and the rollout writes the same cause into the
 * `task_complete` record that closes the turn. Both name the same turn, so
 * the error row they produce can carry one identity derived from the engine's
 * own turn id — which is what lets a later history read *replace* the live
 * copy instead of showing the failure twice.
 *
 * A turn that ended without a cause (the user stopped it, the engine was
 * killed) has nothing to report and no row here: the engine never recorded a
 * failure, so there is nothing to read back.
 *
 * Consumers: `codex-runtime.provider.ts` (live run) and
 * `codex-sessions.provider.ts` (history read).
 */

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * The row id a failed turn's error row carries on both transports.
 *
 * The suffix keeps the row apart from the turn it belongs to: the turn id
 * alone names the turn, and the failure is one row of it.
 *
 * Consumers: `codex-runtime.provider.ts` and `codex-sessions.provider.ts`,
 * which both build the error row of the same turn and therefore have to
 * derive the same id from the same turn.
 */
export function codexTurnFailureRowId(turnId: string): string {
  return `${turnId}_error`;
}

/**
 * Reads the engine's own words for a failure.
 *
 * Two shapes reach this reader: the error object the engines send
 * (`{ message }`) and the flat message older engines put beside it. Either
 * one carries the cause; the reader returns whichever is there.
 *
 * Consumers: `codex-runtime.provider.ts` and `codex-sessions.provider.ts`.
 */
export function readCodexFailureMessage(input: {
  /** The engine's error object. */
  error?: unknown;
  /** The flat message form, used when the engine sends no error object. */
  message?: unknown;
}): string | undefined {
  const error = readObjectRecord(input.error);
  return readOptionalString(error?.message) ?? readOptionalString(input.message);
}

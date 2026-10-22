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
 * killed, the host lost track of which turn answered) has nothing to report
 * and no row here: the engine never recorded a failure, so there is nothing
 * to read back, and a row named after that turn would claim a join the
 * transcript cannot make.
 *
 * Consumers: `codex-runtime.provider.ts` (live run) and
 * `codex-sessions.provider.ts` (history read).
 */

import type { AnyRecord } from '@/shared/types.js';
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
 * Reads the turn id an engine report carries, whichever field it arrives in.
 *
 * The engine names a turn three ways: `turn.id` on a `turn/completed`,
 * `turnId` on an `error` notification, `turn_id` on a rollout record. One
 * reader for all three keeps the row id from quietly degrading into a
 * throwaway one — which would leave the live row and the persisted row as
 * two different rows.
 *
 * Consumers: `codex-runtime.provider.ts` (live run).
 */
export function readCodexReportedTurnId(params: AnyRecord): string | undefined {
  const turn = readObjectRecord(params.turn);
  return readOptionalString(turn?.id)
    ?? readOptionalString(params.turnId)
    ?? readOptionalString(params.turn_id);
}

/**
 * Reads the engine's own words for a failure.
 *
 * Two shapes reach this reader: the error object the engines send
 * (`{ message }`) and the flat message the live notification puts beside it
 * when it sends no error object. Either one carries the cause; the reader
 * returns whichever is there.
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

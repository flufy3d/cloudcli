import { sessionsDb } from '@/modules/database/index.js';

/**
 * The names OpenCode gives its sessions, and what the app does with them.
 *
 * OpenCode names a session on its own and announces the new name on the event
 * stream. The runtime writes that name into the app row, so the database
 * scan that follows the engine's write would otherwise announce the same
 * rename a second time — as a content change, which makes the client
 * re-read the transcript and mark the session as needing attention.
 *
 * This module owns what the engine told us about a session: the name it
 * generated, and whether the app is still behind on the session's other
 * changes. The runtime reports the engine's events here; the session
 * synchronizer asks whether a row has already been applied.
 *
 * Consumers: the OpenCode runtime (reports events, applies names), the
 * OpenCode session synchronizer (skips rows that were applied).
 */

/** How long a recorded engine state stays usable; the scan follows within seconds. */
const RECORD_TTL_MS = 60_000;

/** Engine state the runtime applied, keyed by the engine's session id. */
const appliedEngineStates = new Map<string, number>();

/**
 * The time of the last session event the engine announced, per session.
 *
 * The engine stamps its session events into the session row, so an event the
 * app has not synced yet means the app is behind on more than the name. A
 * rename is the one event the app applies itself, so it is not counted here.
 */
const lastSessionEventAt = new Map<string, number>();

/** Drops the records that outlived their usefulness. */
function dropExpiredRecords(now: number): void {
  for (const [sessionId, recordedAt] of appliedEngineStates) {
    if (now - recordedAt > RECORD_TTL_MS) {
      appliedEngineStates.delete(sessionId);
    }
  }
}

/**
 * Records that the engine moved a session.
 *
 * `engineUpdatedAtMs` is the engine's own timestamp for the event.
 */
export function noteEngineSessionEvent(providerSessionId: string, engineUpdatedAtMs: number): void {
  lastSessionEventAt.set(
    providerSessionId,
    Math.max(lastSessionEventAt.get(providerSessionId) ?? 0, engineUpdatedAtMs),
  );
}

/**
 * Applies the name the engine generated for one session.
 *
 * The name is written into the app row, and the engine's own write is
 * recorded so the scan that follows it does not announce the same rename
 * again. The record is only made when the app is not behind on the session's
 * other changes: the engine stamps every session event into its session row,
 * so an event the app has not synced yet means the scan still has something
 * to announce.
 *
 * Returns whether the name was written and whether the engine's state was
 * recorded as applied.
 */
export function applyEngineRename(input: {
  providerSessionId: string;
  title: string;
  engineUpdatedAtMs: number;
}): { applied: boolean; recorded: boolean } {
  const row = sessionsDb.getSessionByProviderSessionId(input.providerSessionId);
  if (!row || row.provider !== 'opencode') {
    // The app has no row for this session yet; the synchronizer picks the
    // name up when it first indexes the session.
    return { applied: false, recorded: false };
  }

  const lastSyncedAtMs = row.updated_at ? Date.parse(row.updated_at) : 0;
  const appIsBehind = (lastSessionEventAt.get(input.providerSessionId) ?? 0)
    > (Number.isFinite(lastSyncedAtMs) ? lastSyncedAtMs : 0);

  const applied = sessionsDb.applyEngineSessionName(row.session_id, input.title);
  if (!appIsBehind) {
    const now = Date.now();
    dropExpiredRecords(now);
    appliedEngineStates.set(input.providerSessionId, input.engineUpdatedAtMs);
  }
  return { applied, recorded: !appIsBehind };
}

/**
 * True when the engine's current state for this session is the state the
 * runtime already applied, so the scan has nothing left to write.
 *
 * The record is consumed either way: the engine wrote something newer than
 * the recorded state, so the record is stale and dropped.
 */
export function consumeAppliedEngineState(providerSessionId: string, engineUpdatedAtMs: number): boolean {
  const recorded = appliedEngineStates.get(providerSessionId);
  if (recorded === undefined) {
    return false;
  }
  appliedEngineStates.delete(providerSessionId);
  return engineUpdatedAtMs <= recorded;
}

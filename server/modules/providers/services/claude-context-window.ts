import { sessionsDb } from '@/modules/database/index.js';

/**
 * Persistence for the context window a Claude session actually runs against.
 *
 * A Claude transcript records the *resolved* model id for every turn
 * (`claude-opus-5`), never the context-window variant the run was started with
 * (`claude-opus-5[1m]`), so no amount of reading the transcript can tell a 1M
 * session apart from a 200k one. The SDK does know — `getContextUsage()`
 * reports it — but only while a query is live. These two helpers carry that
 * measurement from the run that observed it to every later reader.
 *
 * Kept apart from `claude-usage.ts` so the usage math stays free of database
 * access: this module is the only place the window touches storage.
 */

/**
 * Records the context window one Claude session runs against.
 *
 * Consumer: the Claude runtime provider, at the end of every turn, with the
 * window the SDK reported for that run. Accepts either the app session id or
 * the provider-native one, because a freshly created session is known by the
 * id the SDK announced before the app row adopts it.
 *
 * Silently does nothing when no row matches yet or the database is
 * unavailable: the window is re-reported at the end of the next turn, and
 * losing a badge refinement must never fail a run.
 */
export function recordClaudeSessionContextWindow(
  sessionId: string | null | undefined,
  contextWindow: number,
): void {
  if (!sessionId || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return;
  }

  try {
    const row = sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!row || row.context_window === Math.round(contextWindow)) {
      return;
    }

    sessionsDb.setSessionContextWindow(row.session_id, Math.round(contextWindow));
  } catch {
    // No database context (unit tests, early startup) or a row that vanished
    // mid-run. The next turn records the window again.
  }
}

/**
 * Reads the recorded context window for one Claude session, or null when the
 * app has never run it (or cannot reach the database).
 *
 * Consumers: the Claude sessions provider, which feeds it to the usage
 * resolver for both `/token-usage` and every history page, and the Claude
 * runtime provider, so the per-assistant frames of a resumed session already
 * report the real window instead of waiting for the turn to end.
 */
export function readClaudeSessionContextWindow(
  sessionId: string | null | undefined,
): number | null {
  if (!sessionId) {
    return null;
  }

  try {
    const row = sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    const recorded = row?.context_window ?? null;
    return typeof recorded === 'number' && Number.isFinite(recorded) && recorded > 0
      ? recorded
      : null;
  } catch {
    return null;
  }
}

/**
 * OpenCode Data Root
 *
 * Single source of truth for OpenCode CLI filesystem locations and SQLite
 * storage-layout detection. Mirrors the antigravity/zcode data-root convention
 * so provider path knowledge lives in the provider module rather than the
 * global shared layer.
 *
 * @module opencode-data-root
 */

import os from 'node:os';
import path from 'node:path';

import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * Resolves the OpenCode SQLite session database path.
 *
 * OpenCode stores session, message, and project metadata in one shared
 * `opencode.db` file under its XDG data directory. Provider readers and
 * synchronizers should use this path for read-only access and should never
 * store it as a deletable transcript path for an individual app session row.
 *
 * Consumers: opencode models, sessions, and session synchronizer providers.
 */
export function getOpenCodeDatabasePath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * The SQLite table holding OpenCode session rows.
 *
 * v2 renamed `session` to `session_v2` (same project/directory/title/timestamp
 * columns plus token totals); v1 layouts keep the original table. Consumers
 * must interpolate only this resolver's result — never a user-supplied string.
 */
export type OpenCodeSessionTableName = 'session_v2' | 'session';

/** Minimal structural view of a better-sqlite3 database this module needs. */
type OpenCodeReadableDatabase = Pick<SqliteDatabase, 'prepare'>;

/**
 * Detects which session table the database carries, preferring the v2
 * `session_v2` layout. Returns null when neither table exists (empty or
 * foreign database), which callers treat as "no sessions".
 *
 * Consumers: opencode sessions, session synchronizer, models, and runtime.
 */
export function resolveOpenCodeSessionTableName(
  db: OpenCodeReadableDatabase,
): OpenCodeSessionTableName | null {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session')",
  ).all() as Array<{ name?: string }>;
  const names = new Set(rows.map((row) => row.name));
  if (names.has('session_v2')) {
    return 'session_v2';
  }
  if (names.has('session')) {
    return 'session';
  }
  return null;
}

/**
 * Detects where OpenCode stores message content.
 *
 * v2 folds messages and their content blocks into one `session_message`
 * table; v1 splits them across `message` and `part`. Returns null when
 * neither layout is present.
 *
 * Consumers: opencode sessions history reader.
 */
export function resolveOpenCodeMessageLayout(
  db: OpenCodeReadableDatabase,
): 'session_message' | 'message_part' | null {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'message', 'part')",
  ).all() as Array<{ name?: string }>;
  const names = new Set(rows.map((row) => row.name));
  if (names.has('session_message')) {
    return 'session_message';
  }
  if (names.has('message') && names.has('part')) {
    return 'message_part';
  }
  return null;
}

export type OpenCodeSessionTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Reads one session's token totals from the session table's token columns
 * (v2 `session_v2` and late-v1 `session` alike). Returns null when the
 * database has no session table or the table predates the token columns.
 *
 * Consumers: opencode sessions and runtime token-usage readers.
 */
export function readOpenCodeSessionTokenTotals(
  db: OpenCodeReadableDatabase,
  sessionId: string,
): OpenCodeSessionTokenTotals | null {
  const table = resolveOpenCodeSessionTableName(db);
  if (!table) {
    return null;
  }

  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return null;
  }

  const row = db.prepare(`
    SELECT
      tokens_input AS inputTokens,
      tokens_output AS outputTokens,
      tokens_reasoning AS reasoningTokens,
      tokens_cache_read AS cacheReadTokens,
      tokens_cache_write AS cacheWriteTokens
    FROM ${table}
    WHERE id = ?
  `).get(sessionId) as OpenCodeSessionTokenTotals | undefined;

  return row ?? null;
}

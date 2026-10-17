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

import type { AnyRecord } from '@/shared/types.js';
import {
  readJsonRecord,
  readOptionalString,
} from '@/shared/utils.js';

/**
 * Resolves the OpenCode CLI data directory shared by all of its state files.
 */
function getOpenCodeDataDirectory(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

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
  return path.join(getOpenCodeDataDirectory(), 'opencode.db');
}

/**
 * Resolves the OpenCode credential store path.
 *
 * OpenCode writes every connected provider credential - including the
 * `opencode-go` subscription API key - into one `auth.json` under its XDG
 * data directory.
 *
 * Consumers: opencode auth and quota providers.
 */
export function getOpenCodeAuthPath(): string {
  return path.join(getOpenCodeDataDirectory(), 'auth.json');
}

/**
 * Resolves OpenCode's own model-registry cache path.
 *
 * The file is models.dev data OpenCode refreshed for its registry; its
 * `providerID.modelID.limit.context` entries are the only place this app can
 * learn a model's context window without calling the gateway.
 *
 * Consumers: opencode context usage and runtime providers (context-window
 * lookup for the composer badge's percentage).
 */
export function getOpenCodeModelsCachePath(): string {
  return path.join(os.homedir(), '.cache', 'opencode', 'models.json');
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

/**
 * Reads one session row's stored model selection, normalized to a
 * `providerId/modelId` key (OpenCode's routing key and the models.json cache
 * key). Both layouts store it as a JSON object on the `model` column
 * (`{providerID, id}` or `{providerID, modelID}`); rows that predate the
 * column, or a missing session table, answer null.
 *
 * Consumers: opencode context usage (context-window lookup) and runtime
 * (fallback when a run carries no model reference).
 */
export function readOpenCodeSessionModelKey(
  db: OpenCodeReadableDatabase,
  sessionId: string,
): string | null {
  const table = resolveOpenCodeSessionTableName(db);
  if (!table) {
    return null;
  }

  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === 'model')) {
    return null;
  }

  const row = db.prepare(`SELECT model FROM ${table} WHERE id = ?`).get(sessionId) as { model?: unknown } | undefined;
  const model = readJsonRecord(row?.model);
  if (!model) {
    return null;
  }

  const providerId = readOptionalString(model.providerID) ?? readOptionalString(model.providerId);
  const modelId = readOptionalString(model.id)
    ?? readOptionalString(model.modelID)
    ?? readOptionalString(model.modelId);
  if (!modelId) {
    return null;
  }
  // Some rows carry the routed id as `provider/model` with an optional
  // `#variant` suffix; models.json keys are `provider/model` alone.
  const [bare, inlineProvider] = modelId.includes('/')
    ? [modelId.split('/').slice(1).join('/'), modelId.split('/')[0]]
    : [modelId, null];
  const resolvedProvider = providerId ?? inlineProvider;
  return resolvedProvider ? `${resolvedProvider}/${bare}` : bare;
}

export type OpenCodeAssistantMessageRecord = {
  /** Message row id; identifies the newest compaction summary for the size reading. */
  id: string;
  /** Parsed message payload (raw row data can also be a plain string). */
  data: AnyRecord | null;
};

/**
 * Reads one session's assistant message rows, newest first.
 *
 * Blind to the storage layout: v2 folds messages into `session_message` rows
 * (with the payload inline), v1 splits them across `message` and `part`. Both
 * carry per-message token usage on the assistant payload, which is what the
 * context-usage reader needs; timeline rendering uses the layout-aware
 * fetchers instead. Returns an empty list when neither layout exists.
 *
 * Consumer: opencode context usage.
 */
export function readOpenCodeAssistantMessages(
  db: OpenCodeReadableDatabase,
  sessionId: string,
): OpenCodeAssistantMessageRecord[] {
  const layout = resolveOpenCodeMessageLayout(db);
  if (layout === 'session_message') {
    const rows = db.prepare(`
      SELECT id, data
      FROM session_message
      WHERE session_id = ? AND type = 'assistant'
      ORDER BY seq DESC
    `).all(sessionId) as Array<{ id: string; data: string }>;
    return rows.map((row) => ({ id: row.id, data: readJsonRecord(row.data) }));
  }

  if (layout === 'message_part') {
    // v1 stores the role on each message payload; the LIKE prefilter keeps the
    // scan off user rows whose bodies can be far larger than their headers.
    const rows = db.prepare(`
      SELECT id, data
      FROM message
      WHERE session_id = ?
        AND (data LIKE '%"role":"assistant"%' OR data LIKE '%"role": "assistant"%')
      ORDER BY time_created DESC, id DESC
    `).all(sessionId) as Array<{ id: string; data: string }>;
    return rows.map((row) => ({ id: row.id, data: readJsonRecord(row.data) }));
  }

  return [];
}

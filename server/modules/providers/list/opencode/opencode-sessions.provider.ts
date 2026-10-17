import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
  ProviderSessionUsageInput,
  ProviderTokenUsageResult,
} from '@/shared/types.js';
import {
  AppError,
  createNormalizedMessage,
  generateMessageId,
  normalizeProjectPath,
  normalizeProviderTimestamp,
  readObjectRecord,
  readJsonRecord,
  readOptionalString,
  readUsageNumber,
  removePathIfExists,
  sliceTailPage,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

import {
  getOpenCodeDatabasePath,
  readOpenCodeSessionTokenTotals,
  resolveOpenCodeMessageLayout,
  resolveOpenCodeSessionTableName,
} from './opencode-data-root.js';

const PROVIDER = 'opencode';

type OpenCodeHistoryRow = {
  message_id: string;
  message_time_created: number | null;
  message_data: string | null;
  part_id: string | null;
  part_time_created: number | null;
  part_data: string | null;
};

type OpenCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const openOpenCodeDatabase = (): Database.Database | null => {
  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  return new Database(dbPath, { readonly: true, fileMustExist: true });
};

const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') {
    return unwrapJsonStringLiteral(value);
  }

  const record = readObjectRecord(value);
  const text = readOptionalString(record?.text)
    ?? readOptionalString(record?.content)
    ?? '';
  return unwrapJsonStringLiteral(text);
};

const hasUserRole = (value: unknown): boolean => {
  const record = readObjectRecord(value);
  return readOptionalString(record?.role) === 'user';
};

const isUserTextEcho = (raw: AnyRecord): boolean => {
  return readOptionalString(raw.role) === 'user'
    || hasUserRole(raw.message)
    || hasUserRole(raw.part);
};

const buildTokenUsage = (totals: OpenCodeTokenTotals | undefined): AnyRecord | undefined => {
  if (!totals) {
    return undefined;
  }

  const inputTokens = totals.inputTokens;
  const displayInputTokens = inputTokens + totals.cacheReadTokens;
  const outputTokens = totals.outputTokens;
  const used = inputTokens
    + outputTokens
    + totals.reasoningTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens;

  if (used <= 0) {
    return undefined;
  }

  return {
    used,
    inputTokens: displayInputTokens,
    outputTokens,
    breakdown: {
      input: displayInputTokens,
      output: outputTokens,
    },
  };
};

const readOpenCodeSessionColumnTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => buildTokenUsage(readOpenCodeSessionTokenTotals(db, sessionId) ?? undefined);

/**
 * Flattens v2 `session_message` rows into the (message, part) row shape the
 * history normalizer consumes.
 *
 * v2 event-sources one row per message and carries its content blocks inline
 * (`user` rows hold the prompt text; `assistant` rows hold a `content` array
 * of text/reasoning/tool blocks), so each row expands into one virtual
 * message plus one virtual part per block. Compaction, idle, and system rows
 * carry no user-visible transcript content and are skipped.
 */
const flattenOpenCodeV2HistoryRows = (
  db: Database.Database,
  sessionId: string,
): OpenCodeHistoryRow[] => {
  const messageRows = db.prepare(`
    SELECT id, type, time_created, time_updated, data
    FROM session_message
    WHERE session_id = ?
    ORDER BY seq
  `).all(sessionId) as Array<{
    id: string;
    type: string;
    time_created: number | null;
    time_updated: number | null;
    data: string;
  }>;

  const rows: OpenCodeHistoryRow[] = [];
  for (const messageRow of messageRows) {
    if (messageRow.type !== 'user' && messageRow.type !== 'assistant') {
      continue;
    }

    const data = readJsonRecord(messageRow.data) ?? {};
    // Part rows repeat the message payload (the v1 join did too) so the
    // normalizer can read the role off every row.
    const messageData = JSON.stringify({ role: messageRow.type, error: data.error ?? null });
    rows.push({
      message_id: messageRow.id,
      message_time_created: messageRow.time_created,
      message_data: messageData,
      part_id: null,
      part_time_created: null,
      part_data: null,
    });

    if (messageRow.type === 'user') {
      rows.push({
        message_id: messageRow.id,
        message_time_created: messageRow.time_created,
        message_data: messageData,
        part_id: `${messageRow.id}_text`,
        part_time_created: messageRow.time_created,
        part_data: JSON.stringify({ type: 'text', text: readOptionalString(data.text) ?? '' }),
      });
      continue;
    }

    const content = Array.isArray(data.content) ? data.content : [];
    content.forEach((block, index) => {
      const blockRecord = readObjectRecord(block);
      if (!blockRecord) {
        return;
      }

      const blockType = readOptionalString(blockRecord.type);
      let partData: Record<string, unknown> | null = null;
      if (blockType === 'text' || blockType === 'reasoning') {
        partData = { type: blockType, text: readOptionalString(blockRecord.text) ?? '' };
      } else if (blockType === 'tool') {
        partData = {
          type: 'tool',
          tool: readOptionalString(blockRecord.name) ?? readOptionalString(blockRecord.tool),
          callID: readOptionalString(blockRecord.id),
          state: blockRecord.state ?? {},
        };
      }
      if (!partData) {
        return;
      }

      rows.push({
        message_id: messageRow.id,
        message_time_created: messageRow.time_created,
        message_data: messageData,
        part_id: `${messageRow.id}_${index}`,
        part_time_created: messageRow.time_updated ?? messageRow.time_created,
        part_data: JSON.stringify(partData),
      });
    });
  }

  return rows;
};

/**
 * OpenCode stores per-message token counts on assistant `message.data` objects
 * (see MessageV2.Assistant). Older DBs also had session-level counters; this
 * matches current `opencode.db` layouts that only persist message JSON.
 */
const aggregateOpenCodeSessionTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const sessionColumnUsage = readOpenCodeSessionColumnTokenUsage(db, sessionId);
  if (sessionColumnUsage) {
    return sessionColumnUsage;
  }

  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const row of rows) {
    const info = readJsonRecord(row.data);
    if (readOptionalString(info?.role) !== 'assistant') {
      continue;
    }

    const tokens = readObjectRecord(info?.tokens);
    if (!tokens) {
      continue;
    }

    inputTokens += Number(tokens.input ?? 0);
    outputTokens += Number(tokens.output ?? 0);
    reasoningTokens += Number(tokens.reasoning ?? 0);
    const cache = readObjectRecord(tokens.cache);
    cacheReadTokens += Number(cache?.read ?? 0);
    cacheWriteTokens += Number(cache?.write ?? 0);
  }

  return buildTokenUsage({
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
};

export class OpenCodeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live `opencode run --format json` events into frontend messages.
   *
   * v2 wraps the payload in a `part` object (`{"type":"text","part":{type,
   * text}}`, `{"type":"tool_use","part":{type:"tool",tool,id,state}}`), while
   * v1 carried the fields on the event itself; both shapes are read.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const part = readObjectRecord(raw.part);
    const partState = part ? readObjectRecord(part.state) : null;
    const type = readOptionalString(raw.type) ?? readOptionalString(raw.event);
    const eventSessionId = readOptionalString(raw.sessionID) ?? readOptionalString(raw.sessionId) ?? sessionId;
    const timestamp = normalizeProviderTimestamp(raw.time ?? raw.timestamp);
    const baseId = readOptionalString(raw.id)
      ?? readOptionalString(raw.messageID)
      ?? readOptionalString(part?.id)
      ?? generateMessageId('opencode');

    if (type === 'text') {
      // The client already renders an optimistic user bubble, so provider user
      // echoes must not be streamed back as assistant text.
      if (isUserTextEcho(raw) || (part && isUserTextEcho(part))) {
        return [];
      }

      const content = extractText(raw.text ?? raw.delta ?? raw.message ?? part?.text);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        content,
      })];
    }

    if (type === 'reasoning') {
      const content = extractText(raw.text ?? raw.delta ?? raw.message ?? part?.text);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    if (type === 'tool_use') {
      const toolName = readOptionalString(raw.tool)
        ?? readOptionalString(raw.name)
        ?? readOptionalString(part?.tool)
        ?? 'Tool';
      const toolId = readOptionalString(raw.callID)
        ?? readOptionalString(raw.toolCallId)
        ?? readOptionalString(part?.id)
        ?? baseId;
      const output = raw.output ?? partState?.output;
      const error = raw.error ?? partState?.error;
      const toolMessage = createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName,
        toolInput: raw.input ?? raw.arguments ?? partState?.input ?? part?.input ?? {},
        toolId,
      });

      if (output !== undefined || error !== undefined) {
        toolMessage.toolResult = {
          content: formatToolContent(output ?? error),
          isError: error !== undefined,
        };
      }

      return [toolMessage];
    }

    if (type === 'error') {
      // v2 nests the detail (`{"type":"error","error":{type,message}}`); v1
      // carried a plain string.
      const errorRecord = readObjectRecord(raw.error);
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content: readOptionalString(raw.error)
          ?? readOptionalString(errorRecord?.message)
          ?? readOptionalString(raw.message)
          ?? 'Unknown OpenCode error',
      })];
    }

    if (type === 'step_finish') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    return [];
  }

  /**
   * Loads OpenCode history from the shared SQLite session database.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // OpenCode's shared sqlite database keys messages by the provider-native
    // session id, not the app-facing id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const db = openOpenCodeDatabase();
    if (!db) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const layout = resolveOpenCodeMessageLayout(db);
      if (!layout) {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      }

      // v2 keeps the per-session token totals on the session row; the v1
      // layout aggregates them from per-message rows instead.
      const rows = layout === 'session_message'
        ? flattenOpenCodeV2HistoryRows(db, providerSessionId)
        : this.readV1HistoryRows(db, providerSessionId);
      const tokenUsage = layout === 'session_message'
        ? buildTokenUsage(readOpenCodeSessionTokenTotals(db, providerSessionId) ?? undefined)
        : aggregateOpenCodeSessionTokenUsage(db, providerSessionId);

      const normalized = this.normalizeHistoryRows(rows, sessionId);
      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  /** The v1 message+part layout query, kept for databases predating v2. */
  private readV1HistoryRows(db: Database.Database, providerSessionId: string): OpenCodeHistoryRow[] {
    return db.prepare(`
      SELECT
        m.id AS message_id,
        m.time_created AS message_time_created,
        m.data AS message_data,
        p.id AS part_id,
        p.time_created AS part_time_created,
        p.data AS part_data
      FROM message m
      LEFT JOIN part p
        ON p.session_id = m.session_id
       AND p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY
        COALESCE(m.time_created, 0),
        m.id,
        COALESCE(p.time_created, 0),
        p.id
    `).all(providerSessionId) as OpenCodeHistoryRow[];
  }

  private normalizeHistoryRows(rows: OpenCodeHistoryRow[], sessionId: string): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const emittedMessageErrors = new Set<string>();

    for (const row of rows) {
      const timestamp = normalizeProviderTimestamp(row.part_time_created ?? row.message_time_created);
      const baseId = `${row.message_id}_${row.part_id ?? normalized.length}`;
      const messageInfo = readJsonRecord(row.message_data);
      const messageRole = readOptionalString(messageInfo?.role);

      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(row.message_id)
      ) {
        emittedMessageErrors.add(row.message_id);
        normalized.push(createNormalizedMessage({
          id: `${baseId}_error`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'error',
          content: formatToolContent(messageInfo.error),
        }));
      }

      if (!row.part_id) {
        continue;
      }

      const partData = readJsonRecord(row.part_data) ?? {};
      const partType = readOptionalString(partData.type);
      if (!partType) {
        continue;
      }

      if (partType === 'text') {
        const rawContent = extractText(partData);
        // User prompts sent with attachments carry an <images_input> path
        // list; strip it for display and surface the paths as images.
        const parsedImages = messageRole === 'user'
          ? parseImagesInputTag(rawContent)
          : { text: rawContent, attachments: [] };
        const parsedFiles = messageRole === 'user'
          ? parseFilesInputTag(parsedImages.text)
          : { text: rawContent, attachments: [] };
        if (
          parsedFiles.text.trim()
          || parsedImages.attachments.length > 0
          || parsedFiles.attachments.length > 0
        ) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: messageRole === 'user' ? 'user' : 'assistant',
            content: parsedFiles.text,
            images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
          }));
        }
        continue;
      }

      if (partType === 'reasoning') {
        const content = extractText(partData);
        if (content.trim()) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content,
          }));
        }
        continue;
      }

      if (partType === 'tool') {
        const state = readObjectRecord(partData.state) ?? {};
        const status = readOptionalString(state.status);
        const toolMessage = createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: readOptionalString(partData.tool) ?? 'Tool',
          toolInput: state.input ?? partData.input ?? {},
          toolId: readOptionalString(partData.callID) ?? row.part_id,
        });

        if (status === 'completed' || status === 'error') {
          toolMessage.toolResult = {
            content: formatToolContent(state.output ?? state.error),
            isError: status === 'error',
          };
        }

        normalized.push(toolMessage);
        continue;
      }

      if (partType === 'step-finish') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_end',
        }));
        continue;
      }

      if (partType === 'patch' || partType === 'agent') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: partType === 'patch' ? 'Patch' : 'Agent',
          toolInput: partData,
          toolId: row.part_id,
        }));
      }
    }

    return normalized;
  }

  /**
   * Reads the token usage recorded on the session row's token columns.
   *
   * Consumer: the provider token-usage service. Databases predating the token
   * columns answer with an explicit unsupported result; a database or session
   * row that cannot be found is a 404.
   */
  async getTokenUsage(input: ProviderSessionUsageInput): Promise<ProviderTokenUsageResult> {
    const databasePath = getOpenCodeDatabasePath();
    if (!fsSync.existsSync(databasePath)) {
      throw new AppError('OpenCode database was not found.', {
        code: 'OPENCODE_DATABASE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const table = resolveOpenCodeSessionTableName(database);
      const requiredColumns = [
        'tokens_input',
        'tokens_output',
        'tokens_reasoning',
        'tokens_cache_read',
        'tokens_cache_write',
      ];
      const columnNames = new Set(
        table
          ? (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
          : [],
      );

      if (!table || !requiredColumns.every((column) => columnNames.has(column))) {
        return {
          used: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking is not available in this OpenCode database schema',
        };
      }

      const row = database.prepare(`
        SELECT
          tokens_input AS inputTokens,
          tokens_output AS outputTokens,
          tokens_reasoning AS reasoningTokens,
          tokens_cache_read AS cacheReadTokens,
          tokens_cache_write AS cacheWriteTokens
        FROM ${table}
        WHERE id = ?
      `).get(input.nativeSessionId) as OpenCodeTokenTotals | undefined;

      if (!row) {
        throw new AppError('OpenCode session was not found.', {
          code: 'OPENCODE_SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const inputTokens = readUsageNumber(row.inputTokens) + readUsageNumber(row.cacheReadTokens);
      const outputTokens = readUsageNumber(row.outputTokens);
      const used = readUsageNumber(row.inputTokens)
        + outputTokens
        + readUsageNumber(row.reasoningTokens)
        + readUsageNumber(row.cacheReadTokens)
        + readUsageNumber(row.cacheWriteTokens);

      return {
        used,
        inputTokens,
        outputTokens,
        breakdown: { input: inputTokens, output: outputTokens },
      };
    } finally {
      database.close();
    }
  }

  /**
   * Cleans up OpenCode native storage (SQLite session row and jsonl file if any).
   */
  async cleanupSession(nativeSessionId: string, jsonlPath?: string | null): Promise<boolean> {
    let removed = false;
    if (jsonlPath) {
      if (await removePathIfExists(jsonlPath)) {
        removed = true;
      }
    }
    const openCodeDbPath = getOpenCodeDatabasePath();
    if (fsSync.existsSync(openCodeDbPath)) {
      let db: Database.Database | null = null;
      try {
        db = new Database(openCodeDbPath);
        const table = resolveOpenCodeSessionTableName(db);
        const res = table
          ? db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(nativeSessionId)
          : { changes: 0 };
        if (res.changes > 0) {
          removed = true;
        }
      } catch (err) {
        console.warn('[OpenCodeSessions] Failed to delete OpenCode session row:', err);
      } finally {
        if (db) {
          db.close();
        }
      }
    }
    return removed;
  }

  /**
   * Cleans up OpenCode project storage from SQLite database.
   */
  async cleanupProjectStorage(projectPath: string): Promise<void> {
    const normalizedPath = normalizeProjectPath(projectPath);
    if (!normalizedPath || normalizedPath === path.parse(normalizedPath).root) {
      return;
    }
    const openCodeDbPath = getOpenCodeDatabasePath();
    if (fsSync.existsSync(openCodeDbPath)) {
      let db: Database.Database | null = null;
      try {
        db = new Database(openCodeDbPath);
        const table = resolveOpenCodeSessionTableName(db);
        if (table) {
          db.prepare(`DELETE FROM ${table} WHERE directory = ?`).run(normalizedPath);
        }
      } catch (err) {
        console.warn('[OpenCodeSessions] Failed to clean up OpenCode project sessions:', err);
      } finally {
        if (db) {
          db.close();
        }
      }
    }
  }
}

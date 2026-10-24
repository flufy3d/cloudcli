import Database from 'better-sqlite3';

import { readJsonRecord, readOptionalString, unwrapJsonStringLiteral } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';

import { SqliteSessionSynchronizer } from '../../shared/sessions/sqlite-session-synchronizer.provider.js';

import {
  getOpenCodeDatabasePath,
  resolveOpenCodeMessageLayout,
  resolveOpenCodeSessionTableName,
} from './opencode-data-root.js';
import { consumeAppliedEngineState } from './opencode-engine-renames.js';

type OpenCodeSessionRow = {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number | null;
  time_updated: number | null;
  worktree: string | null;
};

type OpenCodeChildSessionRow = {
  id: string;
};

/**
 * True when the stored title is the placeholder OpenCode falls back to for a
 * session it has not named.
 *
 * The engine's own fallback is `New session - <the session's creation time>`,
 * so only that exact string counts: a title that merely starts with the same
 * words is a name someone chose and must reach the sidebar untouched.
 */
const isEngineDefaultTitle = (title: string, timeCreatedMs: number | null): boolean => {
  if (timeCreatedMs === null) {
    return false;
  }
  return title === `New session - ${new Date(timeCreatedMs).toISOString()}`;
};
/**
 * Session indexer for OpenCode's SQLite-backed session store.
 *
 * Contributes OpenCode's row mapping to the shared SQLite synchronizer
 * skeleton: active (non-archived) sessions joined with their project row,
 * `directory` with `worktree` fallback as project path, and titles that fall
 * back to the session's first user text when OpenCode stored none.
 */
export class OpenCodeSessionSynchronizer extends SqliteSessionSynchronizer<OpenCodeSessionRow> {
  protected readonly fallbackTitle = 'Untitled OpenCode Session';
  protected readonly logTag = '[OpenCodeProvider]';
  protected readonly watchedFileBasenames = ['opencode.db', 'opencode.db-wal'];

  /** Cleared once: rows a pre-`parent_id`-aware version indexed are deleted. */
  private childSessionsPruned = false;

  constructor() {
    super('opencode');
  }

  async synchronize(since?: Date): Promise<number> {
    // The first provider-wide scan also reconciles child rows indexed by
    // older versions: subagent sessions must not surface in the sidebar.
    // Best effort — no OpenCode database (or an unreadable one) simply means
    // there are no child rows to prune, so the failure must not surface as a
    // provider sync failure.
    if (!this.childSessionsPruned) {
      this.childSessionsPruned = true;
      let db: Database.Database | null = null;
      try {
        db = new Database(this.getDatabasePath(), { readonly: true, fileMustExist: true });
        const table = resolveOpenCodeSessionTableName(db);
        const children = table
          ? db.prepare(`SELECT id FROM ${table} WHERE parent_id IS NOT NULL`).all() as OpenCodeChildSessionRow[]
          : [];
        for (const child of children) {
          sessionsDb.deleteSessionByProviderSessionId(child.id, 'opencode');
        }
      } catch {
        // No database, or one that cannot be opened: nothing to prune.
      } finally {
        db?.close();
      }
    }
    return super.synchronize(since);
  }

  protected getDatabasePath(): string {
    return getOpenCodeDatabasePath();
  }

  protected selectSessionRows(
    db: Database.Database,
    sinceMillis: number | null,
    limit: number | null,
  ): OpenCodeSessionRow[] {
    const table = resolveOpenCodeSessionTableName(db);
    if (!table) {
      return [];
    }

    return db.prepare(`
      SELECT
        s.id AS id,
        s.directory AS directory,
        s.title AS title,
        s.time_created AS time_created,
        s.time_updated AS time_updated,
        p.worktree AS worktree
      FROM ${table} s
      LEFT JOIN project p ON p.id = s.project_id
      WHERE s.time_archived IS NULL
        AND s.parent_id IS NULL
        AND (? IS NULL OR COALESCE(s.time_updated, s.time_created, 0) > ?)
      ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC, s.id DESC
      ${limit === null ? '' : 'LIMIT ?'}
    `).all(...(limit === null
      ? [sinceMillis, sinceMillis]
      : [sinceMillis, sinceMillis, limit])) as OpenCodeSessionRow[];
  }

  protected getRowTimestampsMs(row: OpenCodeSessionRow): { createdAtMs: number; updatedAtMs: number } {
    return {
      createdAtMs: row.time_created ?? 0,
      updatedAtMs: row.time_updated ?? row.time_created ?? 0,
    };
  }

  protected getProjectPath(row: OpenCodeSessionRow): string | null {
    return readOptionalString(row.directory) ?? readOptionalString(row.worktree) ?? null;
  }

  protected deriveSessionName(db: Database.Database, row: OpenCodeSessionRow) {
    const title = readOptionalString(row.title) ?? null;
    if (title !== null && !isEngineDefaultTitle(title, row.time_created)) {
      return { name: title, generated: true };
    }
    // No engine title yet: the first user text is only a placeholder, not a
    // name the engine generated, so it never replaces an existing synced name.
    return { name: this.readFirstUserText(db, row.id) ?? null, generated: false };
  }

  /**
   * Skips a row the runtime already applied.
   *
   * The runtime writes the name OpenCode generated into the app row when the
   * engine announces it. The scan that follows the engine's own write would
   * otherwise announce the same rename again, as a content change.
   */
  protected isProviderStateAlreadyApplied(row: OpenCodeSessionRow): boolean {
    if (row.time_updated === null) {
      // Without a timestamp there is nothing to compare the recorded state
      // against, so the row is applied as usual.
      return false;
    }
    return consumeAppliedEngineState(row.id, row.time_updated);
  }

  /**
   * Reads the session's first user text as a title fallback.
   */
  private readFirstUserText(db: Database.Database, sessionId: string): string | undefined {
    try {
      let row: { data: string | null } | undefined;
      if (resolveOpenCodeMessageLayout(db) === 'session_message') {
        row = db.prepare(`
          SELECT data AS data
          FROM session_message
          WHERE session_id = ?
            AND type = 'user'
          ORDER BY seq
          LIMIT 1
        `).get(sessionId) as { data: string | null } | undefined;
      } else {
        row = db.prepare(`
          SELECT p.data AS data
          FROM message m
          INNER JOIN part p
            ON p.session_id = m.session_id
           AND p.message_id = m.id
          WHERE m.session_id = ?
            AND json_extract(m.data, '$.role') = 'user'
            AND json_extract(p.data, '$.type') = 'text'
          ORDER BY COALESCE(m.time_created, 0), COALESCE(p.time_created, 0)
          LIMIT 1
        `).get(sessionId) as { data: string | null } | undefined;
      }

      const data = readJsonRecord(row?.data);
      const text = readOptionalString(data?.text);
      // OpenCode persists the first prompt as a JSON string literal (e.g.
      // `"hello"`), so decode it to avoid titling the session with quotes.
      return text === undefined ? undefined : unwrapJsonStringLiteral(text);
    } catch {
      return undefined;
    }
  }
}

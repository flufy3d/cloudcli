import type Database from 'better-sqlite3';

import { readOptionalString } from '@/shared/utils.js';

import { SqliteSessionSynchronizer } from '../../shared/sessions/sqlite-session-synchronizer.provider.js';

import { getZCodeDatabasePath } from './zcode-data-root.js';

type ZCodeSessionRow = {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number | null;
  time_updated: number | null;
  /** Set when ZCode's own title generation (re)named the session. */
  time_title_updated: number | null;
};

/**
 * Session synchronizer for ZCode's SQLite-backed session store.
 *
 * Contributes ZCode's row mapping to the shared SQLite synchronizer skeleton:
 * top-level sessions only (`parent_id IS NULL`), sub-agent sessions filtered
 * out, ZCode-generated titles used directly, and the workspace `directory` as
 * project path. Row recency folds in `time_title_updated` so a late generated
 * title re-syncs even when message activity has gone quiet.
 */
export class ZCodeSessionSynchronizer extends SqliteSessionSynchronizer<ZCodeSessionRow> {
  protected readonly fallbackTitle = 'Untitled ZCode Session';
  protected readonly logTag = '[ZCodeProvider]';
  protected readonly watchedFileBasenames = ['db.sqlite', 'db.sqlite-wal'];

  constructor() {
    super('zcode');
  }

  protected getDatabasePath(): string {
    return getZCodeDatabasePath();
  }

  protected selectSessionRows(
    db: Database.Database,
    sinceMillis: number | null,
    limit: number | null,
  ): ZCodeSessionRow[] {
    return db.prepare(`
      SELECT
        s.id AS id,
        s.directory AS directory,
        s.title AS title,
        s.time_created AS time_created,
        s.time_updated AS time_updated,
        s.time_title_updated AS time_title_updated
      FROM session s
      WHERE s.parent_id IS NULL
        AND s.id NOT LIKE 'sess_subagent_agent_%'
        AND (? IS NULL OR MAX(s.time_updated, COALESCE(s.time_title_updated, s.time_updated)) > ?)
      ORDER BY s.time_updated DESC, s.id DESC
      ${limit === null ? '' : 'LIMIT ?'}
    `).all(...(limit === null
      ? [sinceMillis, sinceMillis]
      : [sinceMillis, sinceMillis, limit])) as ZCodeSessionRow[];
  }

  protected getRowTimestampsMs(row: ZCodeSessionRow): { createdAtMs: number; updatedAtMs: number } {
    return {
      createdAtMs: row.time_created ?? 0,
      updatedAtMs: Math.max(
        row.time_updated ?? row.time_created ?? 0,
        row.time_title_updated ?? 0,
      ),
    };
  }

  protected getProjectPath(row: ZCodeSessionRow): string | null {
    return readOptionalString(row.directory) ?? null;
  }

  protected deriveSessionName(_db: Database.Database, row: ZCodeSessionRow) {
    const title = readOptionalString(row.title) ?? null;
    // ZCode's `title` is the engine's own naming (first_input at first, then
    // its generated title); whatever it currently says is what we follow.
    return { name: title, generated: title !== null };
  }

  /**
   * Filters out sub-agent sessions (double-check on top of the SQL predicate).
   */
  protected getSessionId(row: ZCodeSessionRow): string | null {
    const sessionId = super.getSessionId(row);
    if (sessionId?.startsWith('sess_subagent_agent_')) {
      return null;
    }
    return sessionId;
  }
}

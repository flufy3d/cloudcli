import type Database from 'better-sqlite3';

import { readOptionalString } from '@/shared/utils.js';

import { SqliteSessionSynchronizer } from '../../shared/sessions/sqlite-session-synchronizer.provider.js';

import { getZCodeDatabasePath } from './zcode-data-root.js';

type ZCodeSessionRow = {
  id: string;
  directory: string | null;
  title: string | null;
  title_source: string | null;
  time_created: number | null;
  time_updated: number | null;
  /** Set when ZCode's own title generation (re)named the session. */
  time_title_updated: number | null;
};

/**
 * The `session.title_source` column tells apart the engine's namings
 * (`generated`, user renames via `custom`) from the raw first input the engine
 * seeds the title with (`first_input`). Older engine databases may not have
 * the column yet; those degrade to content-derived titles.
 */
function hasTitleSourceColumn(db: Database.Database): boolean {
  const columns = db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
  return columns.some((column) => column.name === 'title_source');
}

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
    const titleSourceSelect = hasTitleSourceColumn(db)
      ? 's.title_source AS title_source'
      : 'NULL AS title_source';
    return db.prepare(`
      SELECT
        s.id AS id,
        s.directory AS directory,
        s.title AS title,
        ${titleSourceSelect},
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
    const source = readOptionalString(row.title_source);
    // The engine seeds `title` with the raw first input (`first_input`) before
    // its own title lands; only `generated` (and engine-side `custom` renames)
    // are namings ZCode made itself, so only those may replace an existing
    // synced name — otherwise a session's compact title would balloon back to
    // the raw message until the generated title arrives.
    const generated = source === 'generated' || source === 'custom';
    return { name: title, generated: title !== null && generated };
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

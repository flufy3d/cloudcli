import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { SqliteSessionSynchronizer } from '@/modules/providers/shared/sessions/sqlite-session-synchronizer.provider.js';

type FixtureRow = {
  id: string;
  title: string | null;
  updated_ms: number;
};

class FixtureSynchronizer extends SqliteSessionSynchronizer<FixtureRow> {
  protected readonly fallbackTitle = 'Untitled Fixture';
  protected readonly logTag = '[Fixture]';
  protected readonly watchedFileBasenames = ['fixture.db', 'fixture.db-wal'];

  constructor(private readonly dbPath: string) {
    super('zcode');
  }

  protected getDatabasePath(): string {
    return this.dbPath;
  }

  protected selectSessionRows(
    db: Database.Database,
    sinceMillis: number | null,
    limit: number | null,
  ): FixtureRow[] {
    return db.prepare(`
      SELECT id, title, updated_ms
      FROM session
      WHERE (? IS NULL OR updated_ms > ?)
      ORDER BY updated_ms DESC
      ${limit === null ? '' : 'LIMIT ?'}
    `).all(...(limit === null
      ? [sinceMillis, sinceMillis]
      : [sinceMillis, sinceMillis, limit])) as FixtureRow[];
  }

  protected getRowTimestampsMs(row: FixtureRow): { createdAtMs: number; updatedAtMs: number } {
    return { createdAtMs: row.updated_ms, updatedAtMs: row.updated_ms };
  }

  protected getProjectPath(row: FixtureRow): string | null {
    return row.id === 'no-project' ? null : fixtureWorkspacePath(path.dirname(this.dbPath), row.id);
  }

  protected deriveSessionName(_db: Database.Database, row: FixtureRow): string | null {
    return row.title;
  }
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Workspace directory the fixture rows claim. Session indexing only admits a
 * workspace that still exists on disk, so the fixtures create these for real
 * instead of naming an imaginary `/workspace/...` path.
 */
function fixtureWorkspacePath(directory: string, sessionId: string): string {
  return path.join(directory, 'workspaces', sessionId);
}

/** Creates the fixture provider database with two dated session rows. */
async function createFixtureDatabase(directory: string, rows: FixtureRow[]): Promise<string> {
  const dbPath = path.join(directory, 'fixture.db');
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, updated_ms INTEGER)');
    const insert = db.prepare('INSERT INTO session (id, title, updated_ms) VALUES (?, ?, ?)');
    for (const row of rows) {
      insert.run(row.id, row.title, row.updated_ms);
      await mkdir(fixtureWorkspacePath(directory, row.id), { recursive: true });
    }
  } finally {
    db.close();
  }
  return dbPath;
}

test('synchronizeFile ignores files outside the declared watch basenames', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_1', title: 'One', updated_ms: 1_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      const synchronizer = new FixtureSynchronizer(dbPath);

      assert.equal(await synchronizer.synchronizeFile(path.join(tempDir, 'unrelated.txt')), null);
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_1'), null);

      assert.equal(await synchronizer.synchronizeFile(path.join(tempDir, 'fixture.db-wal')), 'sess_1');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('watch target derives the root from the database path and reuses the basename predicate', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, []);

  try {
    const synchronizer = new FixtureSynchronizer(dbPath);
    const target = synchronizer.getSessionWatchTarget();

    assert.equal(target.rootPath, tempDir);
    assert.equal(target.isTargetFile(path.join(tempDir, 'fixture.db')), true);
    assert.equal(target.isTargetFile(path.join(tempDir, 'fixture.db-wal')), true);
    assert.equal(target.isTargetFile(path.join(tempDir, 'other.db')), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('scan upserts rows, keeps custom names, and reports the first session id', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_a', title: 'Provider title', updated_ms: 2_000 },
    { id: 'sess_b', title: null, updated_ms: 3_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      // A pre-existing app session with a custom name keeps it; the fallback
      // title on an existing row does not.
      sessionsDb.createAppSession('app-b', 'zcode', fixtureWorkspacePath(tempDir, 'sess_b'), 'My custom name');

      const synchronizer = new FixtureSynchronizer(dbPath);
      const processed = await synchronizer.synchronize();
      assert.equal(processed, 2);

      const sessionA = sessionsDb.getSessionByProviderSessionId('sess_a');
      assert.equal(sessionA?.custom_name, 'Provider title');
      assert.equal(sessionA?.jsonl_path, null);

      // sess_a's provider row is separate; the app row keeps its custom name
      // after the provider id was bound to it.
      const sessionB = sessionsDb.getSessionByProviderSessionId('sess_b');
      assert.equal(sessionB?.custom_name, 'My custom name');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('incremental syncs read only rows newer than the high-water mark', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_old', title: 'Old', updated_ms: 1_000 },
    { id: 'sess_new', title: 'New', updated_ms: 2_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      const synchronizer = new FixtureSynchronizer(dbPath);

      assert.equal(await synchronizer.synchronize(), 2);

      // Nothing new since the high-water mark (2_000).
      assert.equal(await synchronizer.synchronizeFile(path.join(tempDir, 'fixture.db')), null);

      // A strictly newer row is picked up; the older one is not reprocessed.
      const db = new Database(dbPath);
      try {
        db.prepare('INSERT INTO session (id, title, updated_ms) VALUES (?, ?, ?)')
          .run('sess_newest', 'Newest', 3_000);
      } finally {
        db.close();
      }
      await mkdir(fixtureWorkspacePath(tempDir, 'sess_newest'), { recursive: true });

      assert.equal(await synchronizer.synchronizeFile(path.join(tempDir, 'fixture.db')), 'sess_newest');
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_old')?.custom_name, 'Old');
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_newest')?.custom_name, 'Newest');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('binds provider-discovered sessions to pending app sessions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_pending', title: 'From provider', updated_ms: 5_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      // The app created a session and is waiting for the provider id to arrive.
      sessionsDb.createAppSession('app-pending', 'zcode', fixtureWorkspacePath(tempDir, 'sess_pending'));

      const synchronizer = new FixtureSynchronizer(dbPath);
      assert.equal(await synchronizer.synchronize(), 1);

      const bound = sessionsDb.getSessionById('app-pending');
      assert.equal(bound?.provider_session_id, 'sess_pending');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rows whose workspace directory has vanished are skipped', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_reaped', title: 'Sandbox run', updated_ms: 1_000 },
    { id: 'sess_live', title: 'Real project', updated_ms: 2_000 },
  ]);

  try {
    // An engine that ran inside a `mktemp -d` sandbox keeps naming that
    // directory long after the system reaped it; indexing the row would
    // re-create the same ghost project on every restart.
    await rm(fixtureWorkspacePath(tempDir, 'sess_reaped'), { recursive: true, force: true });

    await withIsolatedDatabase(async () => {
      const synchronizer = new FixtureSynchronizer(dbPath);
      assert.equal(await synchronizer.synchronize(), 1);
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_reaped'), null);
      assert.ok(sessionsDb.getSessionByProviderSessionId('sess_live'));
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rows without a project path are skipped and a missing database yields zero', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'no-project', title: 'No project', updated_ms: 1_000 },
    { id: 'sess_ok', title: 'Ok', updated_ms: 2_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      const synchronizer = new FixtureSynchronizer(dbPath);
      assert.equal(await synchronizer.synchronize(), 1);
      assert.equal(sessionsDb.getSessionByProviderSessionId('no-project'), null);
      assert.ok(sessionsDb.getSessionByProviderSessionId('sess_ok'));

      // A missing database is a quiet zero, not a throw.
      const missing = new FixtureSynchronizer(path.join(tempDir, 'absent.db'));
      assert.equal(await missing.synchronize(), 0);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

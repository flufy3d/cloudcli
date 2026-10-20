import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  applyEngineRename,
  noteEngineSessionEvent,
} from '@/modules/providers/list/opencode/opencode-engine-renames.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';

import { createWorkspaceFixture } from './workspace-fixture.js';

/**
 * The name OpenCode gives a session it has not named yet.
 *
 * The engine falls back to `New session - <the session's creation time>` and
 * only names a session while it still carries that placeholder. The
 * synchronizer has to tell the placeholder from a name somebody chose: a
 * title that merely starts with the same words is a real title.
 *
 * The second half covers the other side of the same handshake: the runtime
 * applies the name the engine generated, and the scan that follows the
 * engine's own write must not announce the same rename a second time — but it
 * must still announce a session the app is behind on.
 */

const SESSION_CREATED_AT = 1_700_000_000_000;
const SESSION_UPDATED_AT = 1_700_000_004_000;

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-title-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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
 * Writes an OpenCode v2 database holding one root session, in the layout the
 * engine 2.x uses.
 */
const createOpenCodeDatabase = async (
  homeDir: string,
  workspacePath: string,
  session: { id: string; title: string | null; updatedAt: number },
): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );

      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER
      );

      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );

      CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
    `);

    db.prepare(
      'INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)',
    ).run('project-1', workspacePath, SESSION_CREATED_AT, SESSION_CREATED_AT);
    db.prepare(`
      INSERT INTO session_v2 (
        id, project_id, slug, directory, title, version, time_created, time_updated, time_archived
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      session.id,
      'project-1',
      session.id,
      workspacePath,
      session.title,
      '2.0.31',
      SESSION_CREATED_AT,
      session.updatedAt,
    );
    db.prepare(`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES (?, ?, 'user', 1, ?, ?, ?)
    `).run(
      'message-user',
      session.id,
      SESSION_CREATED_AT + 1000,
      SESSION_CREATED_AT + 1000,
      JSON.stringify({ role: 'user', text: JSON.stringify('The first message of the session.') }),
    );
  } finally {
    db.close();
  }
};

/** Writes the engine's own view of a session, the way a rename does. */
const writeEngineSessionTitle = (
  homeDir: string,
  session: { id: string; title: string; updatedAt: number },
): void => {
  const db = new Database(path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db'));
  try {
    db.prepare('UPDATE session_v2 SET title = ?, time_updated = ? WHERE id = ?')
      .run(session.title, session.updatedAt, session.id);
  } finally {
    db.close();
  }
};

const withOpenCodeDatabase = async (
  session: { id: string; title: string | null; updatedAt: number },
  runTest: (context: { homeDir: string; workspacePath: string; databasePath: string }) => Promise<void>,
): Promise<void> => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-title-sync-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath, session);
    await withIsolatedDatabase(() =>
      runTest({
        homeDir: tempRoot,
        workspacePath,
        databasePath: path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'),
      }));
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
};

test('the placeholder the engine falls back to is not read as a name the engine chose', { concurrency: false }, async () => {
  await withOpenCodeDatabase(
    {
      id: 'ses-placeholder',
      title: `New session - ${new Date(SESSION_CREATED_AT).toISOString()}`,
      updatedAt: SESSION_UPDATED_AT,
    },
    async () => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      assert.equal(processed, 1);
      const indexed = sessionsDb.getSessionById('ses-placeholder');
      // The placeholder is not a name; the first user text stands in for it
      // until the engine names the session for real.
      assert.equal(indexed?.custom_name, 'The first message of the session.');
    },
  );
});

test('a title that only starts like the placeholder is a real name', { concurrency: false }, async () => {
  await withOpenCodeDatabase(
    {
      id: 'ses-chosen-title',
      title: 'New session planning notes',
      updatedAt: SESSION_UPDATED_AT,
    },
    async () => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(
        sessionsDb.getSessionById('ses-chosen-title')?.custom_name,
        'New session planning notes',
      );
    },
  );
});

test('the rename the runtime applied is not announced a second time', { concurrency: false }, async () => {
  await withOpenCodeDatabase(
    { id: 'ses-renamed', title: 'The name the engine chose', updatedAt: SESSION_UPDATED_AT },
    async ({ homeDir, databasePath }) => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      await synchronizer.synchronize();
      assert.equal(
        sessionsDb.getSessionById('ses-renamed')?.custom_name,
        'The name the engine chose',
      );

      // The engine names the session and writes it into its own row; the
      // runtime applies the name and announces it as a name-only update.
      const renameTime = SESSION_UPDATED_AT + 1000;
      const applied = applyEngineRename({
        providerSessionId: 'ses-renamed',
        title: 'The name the engine chose',
        engineUpdatedAtMs: renameTime,
      });
      assert.equal(applied.applied, true);
      assert.equal(applied.recorded, true);
      writeEngineSessionTitle(homeDir, {
        id: 'ses-renamed',
        title: 'The name the engine chose',
        updatedAt: renameTime,
      });

      // The scan that follows the engine's own write has nothing left to
      // announce: the client has already seen this name.
      const sessionId = await synchronizer.synchronizeFile(databasePath);
      assert.equal(sessionId, null);
    },
  );
});

test('a session the app is behind on is announced even when the engine named it', { concurrency: false }, async () => {
  await withOpenCodeDatabase(
    { id: 'ses-behind', title: 'The name the engine chose', updatedAt: SESSION_UPDATED_AT },
    async ({ homeDir, databasePath }) => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      await synchronizer.synchronize();

      // The engine moved the session after the app last synced it — a reply
      // landed, say — and then named it. The app is behind, so the scan still
      // has something to announce.
      const renameTime = SESSION_UPDATED_AT + 1000;
      noteEngineSessionEvent('ses-behind', SESSION_UPDATED_AT + 500);
      const applied = applyEngineRename({
        providerSessionId: 'ses-behind',
        title: 'The name the engine chose',
        engineUpdatedAtMs: renameTime,
      });
      assert.equal(applied.applied, true);
      assert.equal(applied.recorded, false, 'the scan must still announce the session');
      writeEngineSessionTitle(homeDir, {
        id: 'ses-behind',
        title: 'The name the engine chose',
        updatedAt: renameTime,
      });

      const sessionId = await synchronizer.synchronizeFile(databasePath);
      assert.equal(sessionId, 'ses-behind');
    },
  );
});

test('a state the engine wrote after the runtime applied one is announced', { concurrency: false }, async () => {
  await withOpenCodeDatabase(
    { id: 'ses-renamed-later', title: 'The name the engine chose', updatedAt: SESSION_UPDATED_AT + 5000 },
    async ({ databasePath }) => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      const sessionId = await synchronizer.synchronizeFile(databasePath);

      assert.equal(sessionId, 'ses-renamed-later');
      assert.equal(
        sessionsDb.getSessionById('ses-renamed-later')?.custom_name,
        'The name the engine chose',
      );
    },
  );
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-wt-'));
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

test('createSession persists worktree metadata passed by the placement resolver', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'ses_wt', 'opencode', '/repo', 'Worktree Session',
      undefined, undefined, undefined,
      { path: '/repo/wt', branch: 'feat/x' },
    );

    const row = sessionsDb.getSessionById('ses_wt');
    assert.equal(row?.project_path, '/repo');
    assert.equal(row?.worktree_path, '/repo/wt');
    assert.equal(row?.worktree_branch, 'feat/x');
  });
});

test('createSession clears stale worktree metadata when the session runs in the main checkout again', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'ses_wt', 'opencode', '/repo', 'Worktree Session',
      undefined, undefined, undefined,
      { path: '/repo/wt', branch: 'feat/x' },
    );

    sessionsDb.createSession('ses_wt', 'opencode', '/repo', 'Worktree Session');

    const row = sessionsDb.getSessionById('ses_wt');
    assert.equal(row?.project_path, '/repo');
    assert.equal(row?.worktree_path, null);
    assert.equal(row?.worktree_branch, null);
  });
});

test('moving a session out archives the abandoned default-named worktree project', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.ensureProjectPath('/repo');
    // Simulates the old auto-registration: default name = directory basename.
    projectsDb.ensureProjectPath('/repo/wt');
    sessionsDb.createSession('ses_wt', 'opencode', '/repo/wt', 'Worktree Session');

    sessionsDb.createSession(
      'ses_wt', 'opencode', '/repo', 'Worktree Session',
      undefined, undefined, undefined,
      { path: '/repo/wt', branch: 'feat/x' },
    );

    assert.equal(projectsDb.getProjectPath('/repo/wt')?.isArchived, 1);
    assert.equal(projectsDb.getProjectPath('/repo')?.isArchived, 0);
  });
});

test('moving a session out keeps a worktree project whose name was deliberately set', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.ensureProjectPath('/repo');
    projectsDb.ensureProjectPath('/repo/wt', 'MirLite · feat/x');
    sessionsDb.createSession('ses_wt', 'opencode', '/repo/wt', 'Worktree Session');

    sessionsDb.createSession(
      'ses_wt', 'opencode', '/repo', 'Worktree Session',
      undefined, undefined, undefined,
      { path: '/repo/wt', branch: 'feat/x' },
    );

    assert.equal(projectsDb.getProjectPath('/repo/wt')?.isArchived, 0);
  });
});

test('moving a session out keeps the previous project while other sessions still live there', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.ensureProjectPath('/repo');
    projectsDb.ensureProjectPath('/repo/wt');
    sessionsDb.createSession('ses_wt', 'opencode', '/repo/wt', 'Worktree Session');
    sessionsDb.createSession('ses_other', 'opencode', '/repo/wt', 'Other Session');

    sessionsDb.createSession(
      'ses_wt', 'opencode', '/repo', 'Worktree Session',
      undefined, undefined, undefined,
      { path: '/repo/wt', branch: 'feat/x' },
    );

    assert.equal(projectsDb.getProjectPath('/repo/wt')?.isArchived, 0);
  });
});

test('a plain project move archives the abandoned project only when it is default-named and empty', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.ensureProjectPath('/workspace/a');
    sessionsDb.createSession('ses_plain', 'claude', '/workspace/a', 'Plain Session');

    sessionsDb.createSession('ses_plain', 'claude', '/workspace/b', 'Plain Session');

    assert.equal(sessionsDb.getSessionById('ses_plain')?.project_path, '/workspace/b');
    // Default name ('a' = directory basename) plus zero remaining sessions:
    // the same phantom-project shape the reunification flow cleans up.
    assert.equal(projectsDb.getProjectPath('/workspace/a')?.isArchived, 1);
  });
});

test('a plain project move keeps the previous project when its name was deliberately set', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.ensureProjectPath('/workspace/a', 'My Workspace');
    sessionsDb.createSession('ses_plain', 'claude', '/workspace/a', 'Plain Session');

    sessionsDb.createSession('ses_plain', 'claude', '/workspace/b', 'Plain Session');

    assert.equal(projectsDb.getProjectPath('/workspace/a')?.isArchived, 0);
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { applySessionWorktreePlacement } from '@/modules/providers/shared/sessions/session-worktree-placement.js';
import type { WorktreeHomeResolver } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-placement-'));
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

/** Fake resolver: reports `home` for `worktreePath`, null for anything else. */
function fakeResolver(worktreePath: string, home: { rootPath: string; branch: string | null } | null): WorktreeHomeResolver {
  return async (directory: string) => (directory === worktreePath ? home : null);
}

test('reunifies a session directory that is a worktree of a registered active project', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.ensureProjectPath('/repo');
    const placement = await applySessionWorktreePlacement(
      '/repo/wt',
      fakeResolver('/repo/wt', { rootPath: '/repo', branch: 'feat/x' }),
    );

    assert.deepEqual(placement, {
      projectPath: '/repo',
      worktree: { path: '/repo/wt', branch: 'feat/x' },
    });
  });
});

test('keeps the session under a worktree project whose display name was chosen deliberately', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.ensureProjectPath('/repo');
    projectsDb.ensureProjectPath('/repo/wt', 'MirLite · feat/x');
    const placement = await applySessionWorktreePlacement(
      '/repo/wt',
      fakeResolver('/repo/wt', { rootPath: '/repo', branch: 'feat/x' }),
    );

    assert.deepEqual(placement, {
      projectPath: '/repo/wt',
      worktree: null,
    });
  });
});

test('reunifies away from a worktree project that only carries the default directory name', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.ensureProjectPath('/repo');
    // `ensureProjectPath` stores the directory basename as the default name,
    // which is exactly what the old auto-registration bug left behind.
    projectsDb.ensureProjectPath('/repo/wt');
    const placement = await applySessionWorktreePlacement(
      '/repo/wt',
      fakeResolver('/repo/wt', { rootPath: '/repo', branch: 'feat/x' }),
    );

    assert.deepEqual(placement, {
      projectPath: '/repo',
      worktree: { path: '/repo/wt', branch: 'feat/x' },
    });
  });
});

test('keeps the current project when the main checkout is not a registered project', async () => {
  await withIsolatedDatabase(async () => {
    const placement = await applySessionWorktreePlacement(
      '/unregistered/wt',
      fakeResolver('/unregistered/wt', { rootPath: '/unregistered', branch: 'feat/x' }),
    );

    assert.deepEqual(placement, { projectPath: '/unregistered/wt', worktree: null });
  });
});

test('keeps the current project when the main checkout project is archived', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.ensureProjectPath('/repo');
    projectsDb.updateProjectIsArchived('/repo', true);
    const placement = await applySessionWorktreePlacement(
      '/repo/wt',
      fakeResolver('/repo/wt', { rootPath: '/repo', branch: 'feat/x' }),
    );

    assert.deepEqual(placement, { projectPath: '/repo/wt', worktree: null });
  });
});

test('keeps the current project when the directory is not a linked worktree', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.ensureProjectPath('/repo');
    const placement = await applySessionWorktreePlacement(
      '/repo',
      fakeResolver('/repo', null),
    );

    assert.deepEqual(placement, { projectPath: '/repo', worktree: null });
  });
});

test('reunifies a detached worktree with a null branch', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.ensureProjectPath('/repo');
    const placement = await applySessionWorktreePlacement(
      '/repo/wt',
      fakeResolver('/repo/wt', { rootPath: '/repo', branch: null }),
    );

    assert.deepEqual(placement, {
      projectPath: '/repo',
      worktree: { path: '/repo/wt', branch: null },
    });
  });
});

test('normalizes the session directory before consulting the resolver', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.ensureProjectPath('/repo');
    const placement = await applySessionWorktreePlacement(
      '/repo/wt/',
      fakeResolver('/repo/wt', { rootPath: '/repo', branch: 'feat/x' }),
    );

    assert.deepEqual(placement, {
      projectPath: '/repo',
      worktree: { path: '/repo/wt', branch: 'feat/x' },
    });
  });
});

test('keeps the raw directory when no resolver is registered or injected', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.ensureProjectPath('/repo');
    const placement = await applySessionWorktreePlacement('/repo/wt');

    assert.deepEqual(placement, { projectPath: '/repo/wt', worktree: null });
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  getArchivedProjectsWithSessions,
  getProjectsWithSessions,
} from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withIsolatedDatabase(runTest: (scratchDir: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-fetch-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
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

test('active-project listing omits workspaces inside operating-system temporary directories', async () => {
  await withIsolatedDatabase(async () => {
    // Rows stay in the database — hidden, not deleted — so a filter revert
    // brings them back. The control project lives outside the temporary roots
    // because the fixture scratch dir itself is a temporary directory.
    projectsDb.ensureProjectPath(tmpdir());
    projectsDb.ensureProjectPath(path.join(tmpdir(), 'task-review-X3ZEvD'));
    const realProject = path.join(os.homedir(), 'Projects', 'real-project');
    projectsDb.ensureProjectPath(realProject);

    const projects = await getProjectsWithSessions({ skipSynchronization: true });

    assert.deepEqual(projects.map((project) => project.fullPath), [realProject]);
  });
});

test('archived-project listing omits workspaces inside operating-system temporary directories', async () => {
  await withIsolatedDatabase(async () => {
    const temporaryRoot = tmpdir();
    const realProject = path.join(os.homedir(), 'Projects', 'archived-real-project');
    projectsDb.ensureProjectPath(temporaryRoot);
    projectsDb.ensureProjectPath(path.join(temporaryRoot, 'task-review-X3ZEvD'));
    projectsDb.ensureProjectPath(realProject);
    projectsDb.updateProjectIsArchived(temporaryRoot, true);
    projectsDb.updateProjectIsArchived(path.join(temporaryRoot, 'task-review-X3ZEvD'), true);
    projectsDb.updateProjectIsArchived(realProject, true);

    const projects = await getArchivedProjectsWithSessions({ skipSynchronization: true });

    assert.deepEqual(projects.map((project) => project.fullPath), [realProject]);
  });
});

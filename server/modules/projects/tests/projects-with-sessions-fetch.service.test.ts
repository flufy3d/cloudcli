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

test('active-project listing omits the operating-system temporary directory root', async () => {
  await withIsolatedDatabase(async (scratchDir) => {
    projectsDb.ensureProjectPath(tmpdir());
    projectsDb.ensureProjectPath(path.join(scratchDir, 'real-project'));

    const projects = await getProjectsWithSessions({ skipSynchronization: true });

    assert.deepEqual(projects.map((project) => project.fullPath), [path.join(scratchDir, 'real-project')]);
  });
});

test('archived-project listing omits the operating-system temporary directory root', async () => {
  await withIsolatedDatabase(async (scratchDir) => {
    const temporaryRoot = tmpdir();
    const realProject = path.join(scratchDir, 'archived-real-project');
    projectsDb.ensureProjectPath(temporaryRoot);
    projectsDb.ensureProjectPath(realProject);
    projectsDb.updateProjectIsArchived(temporaryRoot, true);
    projectsDb.updateProjectIsArchived(realProject, true);

    const projects = await getArchivedProjectsWithSessions({ skipSynchronization: true });

    assert.deepEqual(projects.map((project) => project.fullPath), [realProject]);
  });
});

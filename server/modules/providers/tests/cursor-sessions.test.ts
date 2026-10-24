import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CursorSessionSynchronizer } from '@/modules/providers/list/cursor/cursor-session-synchronizer.provider.js';

import { createWorkspaceFixture } from './workspace-fixture.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'cursor-provider-db-'));
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
 * Writes one Cursor chat transcript. The synchronizer reads the `worker.log`
 * sitting three levels above the chat file, so the file lands two directories
 * below the worker.log directory.
 */
async function writeCursorChat(
  homeDir: string,
  chatFileName: string,
  workspacePath: string,
  firstUserText: string,
): Promise<string> {
  const projectsDir = path.join(homeDir, '.cursor', 'projects');
  const chatDir = path.join(projectsDir, 'proj-hash', 'conv-dir');
  await mkdir(chatDir, { recursive: true });
  await writeFile(
    path.join(projectsDir, 'worker.log'),
    `worker started\nworkspacePath=${workspacePath}\n`,
    'utf8',
  );
  const filePath = path.join(chatDir, chatFileName);
  await writeFile(
    filePath,
    `${JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: `<timestamp>2026-07-07</timestamp><user_query>${firstUserText}</user_query>` }],
      },
    })}\n`,
    'utf8',
  );
  return filePath;
}

test('cursor names a nameless session from the first user line, tags stripped', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cursor-session-sync-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const chatPath = await writeCursorChat(
      tempRoot,
      'cursor-fill.jsonl',
      workspacePath,
      '帮我看看这个报错\n第二行不算',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new CursorSessionSynchronizer();
      const result = await synchronizer.synchronizeFile(chatPath);

      assert.ok(result);
      const session = sessionsDb.getSessionById(result!);
      assert.equal(session?.custom_name, '帮我看看这个报错');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('cursor never overwrites an existing name; the locked one least of all', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cursor-session-sync-keep-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const chatPath = await writeCursorChat(
      tempRoot,
      'cursor-keep.jsonl',
      workspacePath,
      'New first line',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession('cursor-keep', 'cursor', workspacePath, 'Earlier synced name');

      const synchronizer = new CursorSessionSynchronizer();

      // Cursor generates no title of its own: the first line must not drift
      // an existing synced name.
      await synchronizer.synchronizeFile(chatPath);
      assert.equal(sessionsDb.getSessionById('cursor-keep')?.custom_name, 'Earlier synced name');

      sessionsDb.updateSessionCustomName('cursor-keep', 'My rename', { lockName: true });
      await synchronizer.synchronizeFile(chatPath);
      assert.equal(sessionsDb.getSessionById('cursor-keep')?.custom_name, 'My rename');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

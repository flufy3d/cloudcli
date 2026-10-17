import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveTaskWorkerCommand, registerAndStartTaskFromRun } from '@/modules/task-continuations/services/task-continuation-worker-manager.service.js';

test('source runtime starts the source worker even when a stale build artifact exists', async () => {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), 'task-worker-command-'));
  const relativeEntrypoint = path.join('server', 'modules', 'task-continuations', 'cli', 'task-continuation-worker');
  const sourceEntrypoint = path.join(appRoot, `${relativeEntrypoint}.ts`);
  const compiledEntrypoint = path.join(appRoot, 'dist-server', `${relativeEntrypoint}.js`);
  try {
    await mkdir(path.dirname(sourceEntrypoint), { recursive: true });
    await mkdir(path.dirname(compiledEntrypoint), { recursive: true });
    await writeFile(sourceEntrypoint, '// current source', 'utf8');
    await writeFile(compiledEntrypoint, '// stale build', 'utf8');

    assert.deepEqual(resolveTaskWorkerCommand('/workspace/task-continuation-worker-manager.ts', appRoot), {
      command: process.execPath,
      args: [
        path.join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        '--tsconfig',
        path.join(appRoot, 'server', 'tsconfig.json'),
        sourceEntrypoint,
      ],
    });
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test('a disabled feature rejects a still-active run capability before task registration', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousTasksRoot = process.env.CLOUDCLI_TASKS_DIR;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'task-disabled-capability-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');
  const tasksRoot = path.join(temporaryDirectory, 'tasks');
  await writeFile(databasePath, '');
  await mkdir(tasksRoot);
  process.env.DATABASE_PATH = databasePath;
  process.env.CLOUDCLI_TASKS_DIR = tasksRoot;
  try {
    const database = await import('@/modules/database/index.js');
    database.closeConnection();
    await database.initializeDatabase();
    database.userDb.createUser('disabled-capability-user', 'hashed-password');
    await import('@/modules/task-continuations/task-continuations.config.js').then(({ setTaskContinuationsEnabled }) => setTaskContinuationsEnabled(false));
    const capability = await import('@/modules/task-continuations/services/task-run-context.service.js');
    const context = {
      userId: 1,
      sessionId: 'disabled-capability-session',
      runId: 'disabled-capability-run',
      providerThreadId: 'native-disabled-thread',
      sessionProjectPath: temporaryDirectory,
      cwd: path.join(temporaryDirectory, 'missing-working-directory'),
      sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
      approvalPolicy: 'on-request' as const,
    };
    const { token } = capability.createTaskRunCapability(context);
    await assert.rejects(registerAndStartTaskFromRun({
      context,
      capabilityToken: token,
      requestId: 'disabled-request',
      title: 'must not launch',
      command: [process.execPath, '-e', 'process.exit(0)'],
      autoNotify: false,
    }), { code: 'TASK_CONTINUATIONS_DISABLED' });
    const taskCount = database.getConnection().prepare('SELECT COUNT(*) AS count FROM async_tasks').get() as { count: number };
    assert.equal(taskCount.count, 0);
  } finally {
    const database = await import('@/modules/database/index.js');
    database.closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousTasksRoot === undefined) delete process.env.CLOUDCLI_TASKS_DIR;
    else process.env.CLOUDCLI_TASKS_DIR = previousTasksRoot;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, taskContinuationDb, userDb, sessionsDb, appConfigDb } from '@/modules/database/index.js';
import {
  startTaskContinuationRuntime,
  validateTaskContinuationTarget,
} from '@/modules/task-continuations/services/task-continuation-runtime.service.js';

test('bootstrap keeps scanning late worker results while dispatch is disabled', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousTasksRoot = process.env.CLOUDCLI_TASKS_DIR;
  const previousJwtSecret = process.env.JWT_SECRET;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-continuation-runtime-'));
  const databasePath = path.join(directory, 'auth.db');
  const tasksRoot = path.join(directory, 'tasks');
  const workspace = path.join(directory, 'workspace');
  await writeFile(databasePath, '');
  await mkdir(tasksRoot);
  await mkdir(workspace);
  process.env.DATABASE_PATH = databasePath;
  process.env.CLOUDCLI_TASKS_DIR = tasksRoot;
  process.env.JWT_SECRET = 'isolated-task-runtime-jwt';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('runtime-owner', 'hashed-password');
  sessionsDb.createSession('runtime-session', 'codex', workspace, 'Runtime test session');
  appConfigDb.set('async_task_continuations_enabled', 'false');
  taskContinuationDb.registerAsyncTask({
    taskId: 'task_late_runtime_result',
    userId: 1,
    sessionId: 'runtime-session',
    runId: 'runtime-parent-run',
    title: '迟到结果',
    command: JSON.stringify([process.execPath, '-e', '']),
    providerThreadId: 'runtime-native-thread',
    sessionProjectPath: workspace,
    workingDirectory: workspace,
    sandboxPolicyType: 'workspaceWrite',
    networkAccess: false,
    approvalPolicy: 'on-request',
    autoNotify: false,
    tokenHash: 'runtime-test-hash',
    tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  let runtime: Awaited<ReturnType<typeof startTaskContinuationRuntime>> | undefined;
  try {
    runtime = await startTaskContinuationRuntime({
      runtime: {} as never,
      pollIntervalMs: 20,
      historyIntervalMs: 20,
    });
    await mkdir(path.join(tasksRoot, 'task_late_runtime_result'));
    await writeFile(path.join(tasksRoot, 'task_late_runtime_result', 'result.json'), JSON.stringify({
      version: 1, taskId: 'task_late_runtime_result', status: 'completed', exitCode: 0, summary: 'late result recovered',
    }));

    const deadline = Date.now() + 500;
    while (Date.now() < deadline && taskContinuationDb.getTaskById('task_late_runtime_result')?.status !== 'completed') {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(taskContinuationDb.getTaskById('task_late_runtime_result')?.status, 'completed');
    assert.equal(taskContinuationDb.getEventByTaskId('task_late_runtime_result'), null);
  } finally {
    runtime?.stop();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousTasksRoot === undefined) delete process.env.CLOUDCLI_TASKS_DIR;
    else process.env.CLOUDCLI_TASKS_DIR = previousTasksRoot;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    await rm(directory, { recursive: true, force: true });
  }
});

test('dispatch target validation checks active owner, accessible directories, provider and resident work', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-continuation-target-'));
  const databasePath = path.join(directory, 'auth.db');
  const workspace = path.join(directory, 'workspace');
  await writeFile(databasePath, '');
  await mkdir(workspace);
  process.env.DATABASE_PATH = databasePath;
  closeConnection();
  await initializeDatabase();
  userDb.createUser('target-owner', 'hashed-password');
  sessionsDb.createSession('target-session', 'codex', workspace, 'Target test session');
  const base = {
    userId: 1,
    sessionId: 'target-session',
    provider: 'codex',
    sessionProjectPath: workspace,
    workingDirectory: workspace,
  };
  const readyRuntime = { hasRuntime: () => true, hasBackgroundWork: () => false };
  try {
    assert.deepEqual(await validateTaskContinuationTarget({ ...base, runtime: readyRuntime }), { outcome: 'ready' });
    assert.equal((await validateTaskContinuationTarget({
      ...base, runtime: { hasRuntime: () => true, hasBackgroundWork: () => true },
    })).outcome, 'busy');
    assert.equal((await validateTaskContinuationTarget({
      ...base, workingDirectory: path.join(directory, 'missing'), runtime: readyRuntime,
    })).outcome, 'invalid');
    getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = 1').run();
    const inactive = await validateTaskContinuationTarget({ ...base, runtime: readyRuntime });
    assert.deepEqual(inactive, { outcome: 'invalid', reason: 'The task owner is no longer active.' });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
  taskContinuationDb,
  userDb,
} from '@/modules/database/index.js';
import {
  reconcileIncompleteContinuationEvents,
  scanAndRecoverTaskResultsFromDisk,
} from '@/modules/task-continuations/services/task-continuation-recovery.service.js';
import { readAndNormalizeTaskResultFromDisk } from '@/modules/task-continuations/services/task-result.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-recovery-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();
  userDb.createUser('testuser', 'hashedpassword');

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

test('Crash Recovery 1: scanAndRecoverTaskResultsFromDisk recovers completed result on disk before callback', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');
    const tempTasksDir = await mkdtemp(path.join(tmpdir(), 'tasks-root-'));

    try {
      taskContinuationDb.registerAsyncTask({
        taskId: 'task_disk_recovery',
        userId: 1,
        sessionId: 'session-1',
        title: '磁盘断电补录',
        autoNotify: true,
        tokenHash: 'hash-disk',
      });

      // 模拟进程被杀前，执行器已成功写入 result.json，但未发出 HTTP finish 回调
      const taskFolder = path.join(tempTasksDir, 'task_disk_recovery');
      await mkdir(taskFolder, { recursive: true });
      await writeFile(
        path.join(taskFolder, 'result.json'),
        JSON.stringify({
          version: 1,
          taskId: 'task_disk_recovery',
          status: 'completed',
          exitCode: 0,
          summary: '离线执行成功',
        }),
        'utf8',
      );

      // 宿主启动时扫描补录
      const recoveredCount = await scanAndRecoverTaskResultsFromDisk(tempTasksDir);
      assert.equal(recoveredCount, 1);

      const task = taskContinuationDb.getTaskById('task_disk_recovery');
      assert.equal(task?.status, 'completed');
      assert.equal(task?.result_summary, '离线执行成功');

      const event = taskContinuationDb.getEventByTaskId('task_disk_recovery');
      assert.ok(event);
      assert.equal(event?.status, 'pending');
    } finally {
      await rm(tempTasksDir, { recursive: true, force: true });
    }
  });
});

test('disk recovery uses the configured task directory when no root argument is supplied', async () => {
  await withIsolatedDatabase(async () => {
    const previousTasksRoot = process.env.CLOUDCLI_TASKS_DIR;
    const tempTasksDir = await mkdtemp(path.join(tmpdir(), 'tasks-configured-root-'));
    try {
      process.env.CLOUDCLI_TASKS_DIR = tempTasksDir;
      sessionsDb.createSession('session-configured-root', 'codex', '/workspace/demo', 'Test Session');
      taskContinuationDb.registerAsyncTask({
        taskId: 'task-configured-root',
        userId: 1,
        sessionId: 'session-configured-root',
        title: '使用配置目录恢复',
        autoNotify: true,
        tokenHash: 'hash-configured-root',
      });
      const taskFolder = path.join(tempTasksDir, 'task-configured-root');
      await mkdir(taskFolder, { recursive: true });
      await writeFile(path.join(taskFolder, 'result.json'), JSON.stringify({
        version: 1,
        taskId: 'task-configured-root',
        status: 'completed',
        exitCode: 0,
        summary: '配置目录恢复成功',
      }), 'utf8');

      assert.equal(await scanAndRecoverTaskResultsFromDisk(), 1);
    } finally {
      if (previousTasksRoot === undefined) delete process.env.CLOUDCLI_TASKS_DIR;
      else process.env.CLOUDCLI_TASKS_DIR = previousTasksRoot;
      await rm(tempTasksDir, { recursive: true, force: true });
    }
  });
});

test('disk recovery preserves a cancelled task result instead of converting it to success', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-cancelled-recovery', 'codex', '/workspace/demo', 'Test Session');
    const tempTasksDir = await mkdtemp(path.join(tmpdir(), 'tasks-cancelled-recovery-'));
    try {
      taskContinuationDb.registerAsyncTask({
        taskId: 'task-cancelled-recovery',
        userId: 1,
        sessionId: 'session-cancelled-recovery',
        title: '保留取消终态',
        autoNotify: true,
        tokenHash: 'hash-cancelled',
      });
      const taskFolder = path.join(tempTasksDir, 'task-cancelled-recovery');
      await mkdir(taskFolder, { recursive: true });
      await writeFile(path.join(taskFolder, 'result.json'), JSON.stringify({
        version: 1,
        taskId: 'task-cancelled-recovery',
        status: 'cancelled',
        exitCode: 1,
        summary: '用户取消任务',
      }), 'utf8');

      assert.equal(await scanAndRecoverTaskResultsFromDisk(tempTasksDir), 1);
      assert.equal(taskContinuationDb.getTaskById('task-cancelled-recovery')?.status, 'cancelled');
      assert.equal(taskContinuationDb.getTaskById('task-cancelled-recovery')?.exit_code, 1);
      assert.equal(taskContinuationDb.getEventByTaskId('task-cancelled-recovery')?.status, 'pending');
    } finally {
      await rm(tempTasksDir, { recursive: true, force: true });
    }
  });
});

test('disk recovery records an actionable error and leaves an unknown terminal status unconfirmed', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-unknown-recovery', 'codex', '/workspace/demo', 'Test Session');
    const tempTasksDir = await mkdtemp(path.join(tmpdir(), 'tasks-unknown-recovery-'));
    try {
      taskContinuationDb.registerAsyncTask({
        taskId: 'task-unknown-recovery',
        userId: 1,
        sessionId: 'session-unknown-recovery',
        title: '拒绝未知终态',
        autoNotify: true,
        tokenHash: 'hash-unknown',
      });
      const taskFolder = path.join(tempTasksDir, 'task-unknown-recovery');
      await mkdir(taskFolder, { recursive: true });
      await writeFile(path.join(taskFolder, 'result.json'), JSON.stringify({
        version: 1,
        taskId: 'task-unknown-recovery',
        status: 'paused',
        exitCode: 0,
        summary: '不应自动视为完成',
      }), 'utf8');

      assert.equal(await scanAndRecoverTaskResultsFromDisk(tempTasksDir), 0);
      const task = taskContinuationDb.getTaskById('task-unknown-recovery');
      assert.equal(task?.status, 'registered');
      assert.match(String((task as unknown as Record<string, unknown> | null)?.last_error), /status/);
      assert.equal(taskContinuationDb.getEventByTaskId('task-unknown-recovery'), null);
    } finally {
      await rm(tempTasksDir, { recursive: true, force: true });
    }
  });
});

test('disk recovery rejects a result-file symlink that escapes the task directory', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-symlink-recovery', 'codex', '/workspace/demo', 'Test Session');
    const tempParent = await mkdtemp(path.join(tmpdir(), 'tasks-symlink-recovery-'));
    const tempTasksDir = path.join(tempParent, 'tasks');
    try {
      taskContinuationDb.registerAsyncTask({
        taskId: 'task-symlink-recovery',
        userId: 1,
        sessionId: 'session-symlink-recovery',
        title: '拒绝符号链接结果',
        autoNotify: true,
        tokenHash: 'hash-symlink',
      });
      const taskFolder = path.join(tempTasksDir, 'task-symlink-recovery');
      await mkdir(taskFolder, { recursive: true });
      const outsideResult = path.join(tempParent, 'outside-result.json');
      await writeFile(outsideResult, JSON.stringify({
        version: 1,
        taskId: 'task-symlink-recovery',
        status: 'completed',
        exitCode: 0,
        summary: '越界结果',
      }), 'utf8');
      await symlink(outsideResult, path.join(taskFolder, 'result.json'));

      await assert.rejects(readAndNormalizeTaskResultFromDisk({
        taskId: 'task-symlink-recovery',
        tasksRootDir: tempTasksDir,
        resultFilePath: path.join(taskFolder, 'result.json'),
      }), /symbolic link|symlink/i);
      assert.equal(await scanAndRecoverTaskResultsFromDisk(tempTasksDir), 0);
      const task = taskContinuationDb.getTaskById('task-symlink-recovery');
      assert.equal(task?.status, 'registered');
      assert.match(task?.last_error ?? '', /symbolic link|symlink/i);
    } finally {
      await rm(tempParent, { recursive: true, force: true });
    }
  });
});

test('disk recovery reports an invalid root path instead of treating it as an empty task directory', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'tasks-invalid-root-'));
  const filePath = path.join(tempDirectory, 'not-a-directory');
  try {
    await writeFile(filePath, 'x', 'utf8');
    await assert.rejects(scanAndRecoverTaskResultsFromDisk(filePath), /must be a directory/i);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Crash Recovery 4 & 5: reconcileIncompleteContinuationEvents checks history before blind retry', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_sending_crash',
      userId: 1,
      sessionId: 'session-1',
      title: '发送边界崩溃',
      autoNotify: true,
      tokenHash: 'hash-sending',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task_sending_crash',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'digest-crash',
      resultSummary: '完成',
    });
    const eventId = completion.eventId!;

    // 状态流转为 claimed -> sending
    taskContinuationDb.claimEventById({ eventId, leaseOwner: 'old-dispatcher', leaseDurationMs: 30_000 });
    taskContinuationDb.updateEventSending({ eventId, leaseOwner: 'old-dispatcher', hostRunId: 'old-run' });

    // 场景 A: 宿主重启后核对引擎历史，发现历史中已有该 eventId 对应的 turn！
    // 必须直接推进为 accepted，绝不重新发送！
    await reconcileIncompleteContinuationEvents({
      historyChecker: async (checkEventId: string) => {
        if (checkEventId === eventId) {
          return { found: true, engineTurnId: 'turn-existing-999', status: 'completed' };
        }
        return { found: false };
      },
    });

    const reconciledEvent = taskContinuationDb.getEventById(eventId);
    assert.equal(reconciledEvent?.status, 'delivered');
    assert.equal(reconciledEvent?.engine_turn_id, 'turn-existing-999');
  });
});

test('Crash Recovery 8: uncertain history inspection transitions event to needs_review', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_uncertain_crash',
      userId: 1,
      sessionId: 'session-1',
      title: '不确定历史',
      autoNotify: true,
      tokenHash: 'hash-uncertain',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task_uncertain_crash',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'digest-uncertain',
      resultSummary: '完成',
    });
    const eventId = completion.eventId!;

    taskContinuationDb.claimEventById({ eventId, leaseOwner: 'old-dispatcher', leaseDurationMs: 30_000 });
    taskContinuationDb.updateEventSending({ eventId, leaseOwner: 'old-dispatcher', hostRunId: 'old-run' });

    // 历史接口抛出异常（网络中断、历史损坏或分页不全）
    await reconcileIncompleteContinuationEvents({
      historyChecker: async () => {
        throw new Error('History API network failure');
      },
    });

    const reconciledEvent = taskContinuationDb.getEventById(eventId);
    assert.equal(reconciledEvent?.status, 'needs_review');
    assert.ok(reconciledEvent?.last_error?.includes('History API network failure'));
  });
});

test('accepted events are checked against history and failed turns become reply_failed', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-accepted-history', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_accepted_history', userId: 1, sessionId: 'session-accepted-history',
      title: '已接收后崩溃', autoNotify: true, tokenHash: 'hash-accepted-history',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task_accepted_history', status: 'completed', exitCode: 0,
      resultDigest: 'digest-accepted-history', resultSummary: '完成',
    });
    const eventId = completion.eventId!;
    taskContinuationDb.claimEventById({ eventId, leaseOwner: 'dispatcher', leaseDurationMs: 30_000 });
    taskContinuationDb.updateEventSending({ eventId, leaseOwner: 'dispatcher', hostRunId: 'run-history' });
    taskContinuationDb.updateEventAccepted({ eventId, engineTurnId: 'turn-accepted', hostRunId: 'run-history' });

    await reconcileIncompleteContinuationEvents({
      historyChecker: async () => ({
        found: true, engineTurnId: 'turn-accepted', status: 'interrupted',
      }),
    });

    const event = taskContinuationDb.getEventById(eventId);
    assert.equal(event?.status, 'reply_failed');
    assert.equal(event?.engine_turn_id, 'turn-accepted');
    assert.match(event?.last_error ?? '', /interrupted/i);
  });
});

test('accepted events remain accepted while the exact engine turn is still running', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-live-history', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_live_history', userId: 1, sessionId: 'session-live-history',
      title: '进行中的接续', autoNotify: true, tokenHash: 'hash-live-history',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task_live_history', status: 'completed', exitCode: 0,
      resultDigest: 'digest-live-history', resultSummary: '完成',
    });
    const eventId = completion.eventId!;
    taskContinuationDb.claimEventById({ eventId, leaseOwner: 'dispatcher', leaseDurationMs: 30_000 });
    taskContinuationDb.updateEventSending({ eventId, leaseOwner: 'dispatcher', hostRunId: 'run-live' });
    taskContinuationDb.updateEventAccepted({ eventId, engineTurnId: 'turn-live', hostRunId: 'run-live' });

    await reconcileIncompleteContinuationEvents({
      historyChecker: async () => ({
        found: true, engineTurnId: 'turn-live', status: 'inProgress',
      }),
    });

    assert.equal(taskContinuationDb.getEventById(eventId)?.status, 'accepted');
  });
});

test('online history reconciliation leaves an event alone while its local runner is active', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-active-history', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_active_history', userId: 1, sessionId: 'session-active-history',
      title: '仍在运行', autoNotify: true, tokenHash: 'hash-active-history',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task_active_history', status: 'completed', exitCode: 0,
      resultDigest: 'digest-active-history', resultSummary: '完成',
    });
    const eventId = completion.eventId!;
    taskContinuationDb.claimEventById({ eventId, leaseOwner: 'dispatcher', leaseDurationMs: 30_000 });
    taskContinuationDb.updateEventSending({ eventId, leaseOwner: 'dispatcher', hostRunId: 'run-active' });
    taskContinuationDb.updateEventAccepted({ eventId, engineTurnId: 'turn-active', hostRunId: 'run-active' });

    await reconcileIncompleteContinuationEvents({
      includeSending: false,
      excludedEventIds: new Set([eventId]),
      historyChecker: async () => ({ found: false }),
    });

    assert.equal(taskContinuationDb.getEventById(eventId)?.status, 'accepted');
  });
});

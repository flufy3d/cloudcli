import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  dispatchTaskContinuationEvent,
  startTaskContinuationWorker,
} from '@/modules/task-continuations/services/task-continuation-dispatcher.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-dispatcher-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();
  userDb.createUser('testuser', 'hashedpassword');
  chatRunRegistry.clearAll();

  try {
    await runTest();
  } finally {
    closeConnection();
    chatRunRegistry.clearAll();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('dispatchTaskContinuationEvent dispatches and delivers when session is idle', async () => {
  await withIsolatedDatabase(async () => {
    const taskOwnerId = Number(userDb.createUser('task-owner', 'hashed-task-owner').id);
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-dispatch-1',
      userId: taskOwnerId,
      sessionId: 'session-1',
      providerThreadId: 'session-1', sessionProjectPath: '/workspace/demo',
      workingDirectory: '/workspace/demo', sandboxPolicyType: 'workspaceWrite',
      networkAccess: false, approvalPolicy: 'on-request',
      title: '空闲测试',
      autoNotify: true,
      tokenHash: 'hash-1',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-dispatch-1',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'digest-1',
      resultSummary: '任务成功完成',
    });
    const eventId = completion.eventId!;

    let runnerCalledWith: any = null;
    let eventStatusDuringRun: string | null = null;
    const mockRunner = async (params: any) => {
      runnerCalledWith = params;
      params.onEngineTurnStarted('turn-mock-123');
      eventStatusDuringRun = taskContinuationDb.getEventById(eventId)?.status ?? null;
      return { success: true, engineTurnId: 'turn-mock-123', terminalStatus: 'completed' as const };
    };

    const dispatched = await dispatchTaskContinuationEvent({
      eventId,
      leaseOwner: 'test-dispatcher',
      runner: mockRunner,
    });

    assert.equal(dispatched, true);
    assert.ok(runnerCalledWith);
    assert.equal(runnerCalledWith.sessionId, 'session-1');
    assert.equal(runnerCalledWith.taskId, 'task-dispatch-1');
    assert.equal(runnerCalledWith.userId, taskOwnerId);
    assert.equal(eventStatusDuringRun, 'accepted');

    const eventRow = taskContinuationDb.getEventById(eventId);
    assert.equal(eventRow?.status, 'delivered');
    assert.equal(eventRow?.engine_turn_id, 'turn-mock-123');
  });
});

test('dispatchTaskContinuationEvent yields back to pending when session is busy', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-busy', 'codex', '/workspace/demo', 'Busy Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-dispatch-busy',
      userId: 1,
      sessionId: 'session-busy',
      providerThreadId: 'session-busy', sessionProjectPath: '/workspace/demo',
      workingDirectory: '/workspace/demo', sandboxPolicyType: 'workspaceWrite',
      networkAccess: false, approvalPolicy: 'on-request',
      title: '忙碌退让测试',
      autoNotify: true,
      tokenHash: 'hash-busy',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-dispatch-busy',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'digest-busy',
      resultSummary: '完成',
    });
    const eventId = completion.eventId!;

    // 模拟会话处于运行中（用户正在交互）
    chatRunRegistry.startRun({
      appSessionId: 'session-busy',
      provider: 'codex',
      providerSessionId: null,
      connection: null,
      userId: 1,
    });
    assert.equal(chatRunRegistry.isProcessing('session-busy'), true);

    let runnerCalled = false;
    const mockRunner = async () => {
      runnerCalled = true;
      return { success: true, engineTurnId: 'turn-should-not-run', terminalStatus: 'completed' as const };
    };

    const dispatched = await dispatchTaskContinuationEvent({
      eventId,
      leaseOwner: 'test-dispatcher',
      runner: mockRunner,
    });

    // 派发器发现会话忙，不调用 runner，并将事件安全释放回 pending
    assert.equal(dispatched, false);
    assert.equal(runnerCalled, false);

    const eventRow = taskContinuationDb.getEventById(eventId);
    assert.equal(eventRow?.status, 'pending');
    assert.equal(eventRow?.lease_owner, null);
  });
});

test('dispatcher releases a claimed event when target engine background work is still active', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-background-gate', 'codex', '/workspace/demo', 'Background gate');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-background-gate', userId: 1, sessionId: 'session-background-gate',
      title: '后台工作结束后再汇报', autoNotify: true, tokenHash: 'hash-background-gate',
      providerThreadId: 'session-background-gate', sessionProjectPath: '/workspace/demo',
      workingDirectory: '/workspace/demo', sandboxPolicyType: 'workspaceWrite',
      networkAccess: false, approvalPolicy: 'on-request',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-background-gate', status: 'completed', exitCode: 0,
      resultDigest: 'digest-background-gate', resultSummary: '完成',
    });
    let runnerCalled = false;
    let targetChecked = false;

    await dispatchTaskContinuationEvent({
      eventId: completion.eventId!, leaseOwner: 'background-gate',
      validateTarget: async () => {
        targetChecked = true;
        return { outcome: 'busy', reason: 'engine background work is active' };
      },
      runner: async () => {
        runnerCalled = true;
        return { success: true, terminalStatus: 'completed' as const, engineTurnId: 'must-not-run' };
      },
    });

    assert.equal(targetChecked, true);
    assert.equal(runnerCalled, false);
    assert.equal(taskContinuationDb.getEventById(completion.eventId!)?.status, 'pending');
  });
});

test('typed busy from the atomic run reservation releases sending back to pending', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-busy-race', 'codex', '/workspace/demo', 'Busy race');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-busy-race', userId: 1, sessionId: 'session-busy-race',
      providerThreadId: 'session-busy-race', sessionProjectPath: '/workspace/demo',
      workingDirectory: '/workspace/demo', sandboxPolicyType: 'workspaceWrite', networkAccess: false,
      approvalPolicy: 'on-request', title: '用户先占用', autoNotify: true, tokenHash: 'hash-busy-race',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-busy-race', status: 'completed', exitCode: 0,
      resultDigest: 'digest-busy-race', resultSummary: '完成',
    });
    const eventId = completion.eventId!;
    const result = await dispatchTaskContinuationEvent({
      eventId, leaseOwner: 'busy-race-worker',
      runner: async () => ({ outcome: 'busy', error: 'User acquired the session reservation.' }),
    });
    assert.equal(result, false);
    const event = taskContinuationDb.getEventById(eventId);
    assert.equal(event?.status, 'pending');
    assert.equal(event?.host_run_id, null);
    assert.equal(event?.engine_turn_id, null);
  });
});

test('dispatchTaskContinuationEvent leaves an unknown pre-accept outcome in needs_review', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-fail', 'codex', '/workspace/demo', 'Fail Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-dispatch-fail',
      userId: 1,
      sessionId: 'session-fail',
      providerThreadId: 'session-fail', sessionProjectPath: '/workspace/demo',
      workingDirectory: '/workspace/demo', sandboxPolicyType: 'workspaceWrite',
      networkAccess: false, approvalPolicy: 'on-request',
      title: '失败回执测试',
      autoNotify: true,
      tokenHash: 'hash-fail',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-dispatch-fail',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'digest-fail',
      resultSummary: '完成',
    });
    const eventId = completion.eventId!;

    const mockRunner = async () => {
      return { success: false, terminalStatus: 'unknown' as const, error: 'Engine turn interrupted by timeout' };
    };

    const dispatched = await dispatchTaskContinuationEvent({
      eventId,
      leaseOwner: 'test-dispatcher',
      runner: mockRunner,
    });

    assert.equal(dispatched, false);
    const eventRow = taskContinuationDb.getEventById(eventId);
    assert.equal(eventRow?.status, 'needs_review');
    assert.equal(eventRow?.last_error, 'Engine turn interrupted by timeout');
  });
});

test('dispatchTaskContinuationEvent records a failed accepted turn as reply_failed', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-terminal-fail', 'codex', '/workspace/demo', 'Fail Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-terminal-fail',
      userId: 1,
      sessionId: 'session-terminal-fail',
      providerThreadId: 'session-terminal-fail', sessionProjectPath: '/workspace/demo',
      workingDirectory: '/workspace/demo', sandboxPolicyType: 'workspaceWrite',
      networkAccess: false, approvalPolicy: 'on-request',
      title: '失败终态不当作已送达',
      autoNotify: true,
      tokenHash: 'hash-terminal-fail',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-terminal-fail',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'digest-terminal-fail',
      resultSummary: '完成',
    });
    const eventId = completion.eventId!;

    const dispatched = await dispatchTaskContinuationEvent({
      eventId,
      leaseOwner: 'test-dispatcher',
      runner: async () => ({
        success: false,
        engineTurnId: 'turn-failed-real',
        terminalStatus: 'failed',
        error: 'The engine turn failed.',
      }),
    });

    assert.equal(dispatched, false);
    const eventRow = taskContinuationDb.getEventById(eventId);
    assert.equal(eventRow?.status, 'reply_failed');
    assert.equal(eventRow?.engine_turn_id, 'turn-failed-real');
    assert.equal(eventRow?.last_error, 'The engine turn failed.');
  });
});

test('dispatcher does not send an old task result after the session has moved to a forked thread', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-fork-check', 'codex', '/workspace/demo', 'Fork check');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-fork-check', userId: 1, sessionId: 'session-fork-check',
      title: '旧会话结果', autoNotify: true, tokenHash: 'hash-fork-check',
      providerThreadId: 'session-fork-check', sessionProjectPath: '/workspace/demo',
      workingDirectory: '/workspace/demo', sandboxPolicyType: 'workspaceWrite',
      networkAccess: false, approvalPolicy: 'on-request',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-fork-check', status: 'completed', exitCode: 0,
      resultDigest: 'digest-fork-check', resultSummary: '完成',
    });
    sessionsDb.assignProviderSessionId('session-fork-check', 'native-fork-thread');
    let runnerCalled = false;

    await dispatchTaskContinuationEvent({
      eventId: completion.eventId!, leaseOwner: 'fork-check',
      runner: async () => {
        runnerCalled = true;
        return { success: true, terminalStatus: 'completed' as const, engineTurnId: 'wrong-target' };
      },
    });

    assert.equal(runnerCalled, false);
    assert.equal(taskContinuationDb.getEventById(completion.eventId!)?.status, 'needs_review');
  });
});

test('continuation worker periodically rechecks accepted engine turns', async () => {
  await withIsolatedDatabase(async () => {
    let historyChecks = 0;
    const worker = startTaskContinuationWorker({
      runner: async () => ({ success: true, terminalStatus: 'completed' as const }),
      pollIntervalMs: 60_000,
      historyIntervalMs: 5,
      reconcileAccepted: async () => { historyChecks += 1; },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 35));
      assert.ok(historyChecks > 0);
    } finally {
      worker.stop();
    }
  });
});

test('disabled task continuation feature stops dispatch without stopping history reconciliation', async () => {
  await withIsolatedDatabase(async () => {
    let runs = 0;
    let checks = 0;
    const worker = startTaskContinuationWorker({
      runner: async () => {
        runs += 1;
        return { success: true, terminalStatus: 'completed' as const };
      },
      shouldDispatch: () => false,
      pollIntervalMs: 5,
      historyIntervalMs: 5,
      reconcileAccepted: async () => { checks += 1; },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(runs, 0);
      assert.ok(checks > 0);
    } finally {
      worker.stop();
    }
  });
});

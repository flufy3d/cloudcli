import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { taskContinuationDb } from '@/modules/database/repositories/task-continuation.repository.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { runMigrations } from '@/modules/database/migrations.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const tsxEntryPoint = path.join(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');
const serverTsConfig = path.join(repositoryRoot, 'server/tsconfig.json');
const databaseModuleUrl = new URL('../index.ts', import.meta.url).href;

async function withIsolatedDatabase(runTest: (temporaryDirectory: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-cont-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();
  userDb.createUser('testuser', 'hashedpassword');

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

async function runConcurrentTaskCalls(input: {
  temporaryDirectory: string;
  mode: string;
  taskId: string;
  eventId?: string;
}): Promise<unknown[]> {
  const gatePath = path.join(input.temporaryDirectory, `${input.mode}.go`);
  const childPath = path.join(input.temporaryDirectory, `${input.mode}-child.mts`);
  const childSource = `
import { access } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
const database = await import(${JSON.stringify(databaseModuleUrl)});
const [, , mode, gatePath, taskId, eventId, workerId] = process.argv;
process.stdout.write('READY' + String.fromCharCode(10));
while (true) { try { await access(gatePath); break; } catch { await sleep(5); } }
let result;
if (mode === 'finish') {
  result = database.taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({ taskId, status: 'completed', exitCode: 0, resultDigest: 'parallel-same-digest', resultSummary: 'same result' });
} else if (mode === 'claim') {
  result = database.taskContinuationDb.claimPendingEvent({ leaseOwner: workerId, leaseDurationMs: 60_000 });
} else if (mode === 'cancel') {
  result = database.taskContinuationDb.cancelNotificationForTask(taskId, 'parallel cancel');
} else if (mode === 'retry') {
  result = database.taskContinuationDb.manuallyRequeueEvent({ eventId, userId: 1, reason: 'parallel retry decision' });
}
process.stdout.write('RESULT ' + JSON.stringify(result) + String.fromCharCode(10));
database.closeConnection();
`;
  await writeFile(childPath, childSource);

  const workers = [1, 2].map((index) => {
    const child = spawn(process.execPath, [
      tsxEntryPoint,
      '--tsconfig',
      serverTsConfig,
      childPath,
      input.mode,
      gatePath,
      input.taskId,
      input.eventId ?? '',
      `worker-${index}`,
    ], {
      cwd: repositoryRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

    let hasReadiness = false;
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', () => {
        if (!hasReadiness && stdout.includes('READY' + String.fromCharCode(10))) {
          hasReadiness = true;
          resolve();
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!hasReadiness) reject(new Error(`Concurrent child exited before READY (${code}): ${stderr}`));
      });
    });
    const done = new Promise<unknown>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Concurrent child exited ${code}: ${stderr}`));
          return;
        }
        const resultLine = stdout.split(String.fromCharCode(10)).find((line) => line.startsWith('RESULT '));
        if (!resultLine) {
          reject(new Error(`Concurrent child did not return a result: ${stdout}`));
          return;
        }
        resolve(JSON.parse(resultLine.slice('RESULT '.length)));
      });
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    void done.finally(() => clearTimeout(timeout));
    return { child, ready, done };
  });

  try {
    await Promise.all(workers.map(({ ready }) => ready));
    await writeFile(gatePath, 'go');
    return await Promise.all(workers.map(({ done }) => done));
  } catch (error) {
    for (const { child } of workers) child.kill('SIGKILL');
    throw error;
  }
}

test('registerAsyncTask stores registered task with proper initial state', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');

    const task = taskContinuationDb.registerAsyncTask({
      taskId: 'task-100',
      userId: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      title: '编译检查任务',
      command: 'npm run build',
      providerThreadId: 'native-thread-original',
      sessionProjectPath: '/workspace/project-root',
      workingDirectory: '/workspace/original',
      sandboxPolicyType: 'workspaceWrite',
      networkAccess: false,
      approvalPolicy: 'on-request',
      autoNotify: true,
      tokenHash: 'hash-abc',
      tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    assert.equal(task.task_id, 'task-100');
    assert.equal(task.session_id, 'session-1');
    assert.equal(task.title, '编译检查任务');
    assert.equal(task.status, 'registered');
    assert.equal(task.auto_notify, 1);
    assert.equal(task.provider_thread_id, 'native-thread-original');
    assert.equal(task.session_project_path, '/workspace/project-root');
    assert.equal(task.working_directory, '/workspace/original');
    assert.equal(task.sandbox_policy_type, 'workspaceWrite');
    assert.equal(task.network_access, 0);
    assert.equal(task.approval_policy, 'on-request');

    const fetched = taskContinuationDb.getTaskById('task-100');
    assert.deepEqual(fetched, task);
  });
});

test('parallel same-result completions return one idempotent event across processes', async () => {
  await withIsolatedDatabase(async (temporaryDirectory) => {
    sessionsDb.createSession('session-parallel-finish', 'codex', temporaryDirectory, 'Concurrent finish');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_parallel_finish', userId: 1, sessionId: 'session-parallel-finish',
      title: 'Concurrent finish', autoNotify: true, tokenHash: 'parallel-finish-hash',
    });

    const results = await runConcurrentTaskCalls({
      temporaryDirectory,
      mode: 'finish',
      taskId: 'task_parallel_finish',
    }) as Array<{ eventId: string | null; isDuplicate: boolean }>;

    assert.equal(results[0].eventId, results[1].eventId);
    assert.equal(results.filter(({ isDuplicate }) => isDuplicate).length, 1);
    const eventCount = getConnection().prepare(
      'SELECT COUNT(*) AS count FROM task_continuation_events WHERE task_id = ?',
    ).get('task_parallel_finish') as { count: number };
    assert.equal(eventCount.count, 1);
  });
});

test('parallel pending-event claims return the lease to only one process', async () => {
  await withIsolatedDatabase(async (temporaryDirectory) => {
    sessionsDb.createSession('session-parallel-claim', 'codex', temporaryDirectory, 'Concurrent claim');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_parallel_claim', userId: 1, sessionId: 'session-parallel-claim',
      title: 'Concurrent claim', autoNotify: true, tokenHash: 'parallel-claim-hash',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task_parallel_claim', status: 'completed', exitCode: 0,
      resultDigest: 'parallel-claim-digest', resultSummary: 'claim me',
    });

    const results = await runConcurrentTaskCalls({
      temporaryDirectory,
      mode: 'claim',
      taskId: 'task_parallel_claim',
    }) as Array<{ event_id: string } | null>;

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(results.find(Boolean)?.event_id, completion.eventId);
  });
});

test('parallel task notification cancellations both report cancelled', async () => {
  await withIsolatedDatabase(async (temporaryDirectory) => {
    sessionsDb.createSession('session-parallel-cancel', 'codex', temporaryDirectory, 'Concurrent cancel');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_parallel_cancel', userId: 1, sessionId: 'session-parallel-cancel',
      title: 'Concurrent cancel', autoNotify: true, tokenHash: 'parallel-cancel-hash',
    });

    const results = await runConcurrentTaskCalls({
      temporaryDirectory,
      mode: 'cancel',
      taskId: 'task_parallel_cancel',
    }) as Array<'cancelled' | 'already_sending' | 'already_terminal' | 'not_found'>;

    assert.deepEqual(results, ['cancelled', 'cancelled']);
    assert.ok(taskContinuationDb.getTaskById('task_parallel_cancel')?.notification_cancelled_at);
  });
});

test('parallel manual retries create one audit row and one pending attempt', async () => {
  await withIsolatedDatabase(async (temporaryDirectory) => {
    sessionsDb.createSession('session-parallel-retry', 'codex', temporaryDirectory, 'Concurrent retry');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_parallel_retry', userId: 1, sessionId: 'session-parallel-retry',
      title: 'Concurrent retry', autoNotify: true, tokenHash: 'parallel-retry-hash',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task_parallel_retry', status: 'completed', exitCode: 0,
      resultDigest: 'parallel-retry-digest', resultSummary: 'retry me',
    });
    const eventId = completion.eventId!;
    taskContinuationDb.claimEventById({ eventId, leaseOwner: 'old-attempt', leaseDurationMs: 60_000 });
    taskContinuationDb.updateEventSending({ eventId, leaseOwner: 'old-attempt', hostRunId: 'old-host' });
    taskContinuationDb.updateEventAccepted({ eventId, engineTurnId: 'old-turn', hostRunId: 'old-host' });
    taskContinuationDb.updateEventFailed({
      eventId, error: 'History is incomplete.', terminalStatus: 'needs_review', expectedStatus: 'accepted',
      engineTurnId: 'old-turn',
    });

    const results = await runConcurrentTaskCalls({
      temporaryDirectory,
      mode: 'retry',
      taskId: 'task_parallel_retry',
      eventId,
    }) as boolean[];

    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(taskContinuationDb.getEventById(eventId)?.status, 'pending');
    const auditCount = getConnection().prepare(
      'SELECT COUNT(*) AS count FROM task_continuation_manual_actions WHERE event_id = ?',
    ).get(eventId) as { count: number };
    assert.equal(auditCount.count, 1);
  });
});

test('recordTaskCompletionAndCreateContinuationEvent atomic dual-write and idempotency', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-200',
      userId: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      title: '单元测试',
      autoNotify: true,
      tokenHash: 'hash-abc',
    });

    // 第一次提交终态：成功落库并生成投递事件
    const result1 = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-200',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'sha256-hash-xyz',
      resultSummary: '全部 12 个测试通过',
      resultJson: JSON.stringify({ passed: 12 }),
    });

    assert.equal(result1.taskId, 'task-200');
    assert.ok(result1.eventId);
    assert.equal(result1.status, 'completed');
    assert.equal(result1.isDuplicate, false);

    const taskRow = taskContinuationDb.getTaskById('task-200');
    assert.equal(taskRow?.status, 'completed');
    assert.equal(taskRow?.exit_code, 0);

    const eventRow = taskContinuationDb.getEventById(result1.eventId);
    assert.equal(eventRow?.task_id, 'task-200');
    assert.equal(eventRow?.status, 'pending');

    // 第二次提交相同终态与摘要：幂等返回已有事件 ID
    const result2 = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-200',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'sha256-hash-xyz',
      resultSummary: '全部 12 个测试通过',
      resultJson: JSON.stringify({ passed: 12 }),
    });

    assert.equal(result2.eventId, result1.eventId);
    assert.equal(result2.isDuplicate, true);

    // 提交冲突结果：抛出异常
    assert.throws(
      () => {
        taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
          taskId: 'task-200',
          status: 'failed',
          exitCode: 1,
          resultDigest: 'sha256-different-hash',
          resultSummary: '失败',
        });
      },
      (error: any) => {
        return error.code === 'TASK_RESULT_CONFLICT' && /Conflict on task/.test(error.message);
      },
    );
  });
});

test('recordTaskCompletionAndCreateContinuationEvent rolls task update back when event insert fails', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-atomic-rollback', 'codex', '/workspace/demo', 'Atomic rollback');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task_atomic_rollback',
      userId: 1,
      sessionId: 'session-atomic-rollback',
      title: 'Atomic rollback',
      autoNotify: true,
      tokenHash: 'atomic-rollback-hash',
    });
    const db = getConnection();
    db.exec(`
      CREATE TRIGGER fail_task_event_insert
      BEFORE INSERT ON task_continuation_events
      BEGIN
        SELECT RAISE(ABORT, 'injected event insertion failure');
      END;
    `);

    assert.throws(
      () => taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
        taskId: 'task_atomic_rollback',
        status: 'completed',
        exitCode: 0,
        resultDigest: 'atomic-rollback-digest',
        resultSummary: 'must roll back',
      }),
      /injected event insertion failure/,
    );
    assert.equal(taskContinuationDb.getTaskById('task_atomic_rollback')?.status, 'registered');
    assert.equal(taskContinuationDb.getTaskById('task_atomic_rollback')?.result_digest, null);
    assert.equal(taskContinuationDb.getEventByTaskId('task_atomic_rollback'), null);

    db.exec('DROP TRIGGER fail_task_event_insert');
    const completed = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task_atomic_rollback',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'atomic-rollback-digest',
      resultSummary: 'retry after trigger removal',
    });
    assert.equal(completed.status, 'completed');
    assert.ok(completed.eventId);
  });
});

test('autoNotify=false does not generate continuation event upon completion', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-300',
      userId: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      title: '仅记录任务',
      autoNotify: false,
      tokenHash: 'hash-abc',
    });

    const result = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-300',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'sha256-hash-300',
      resultSummary: '完成',
    });

    assert.equal(result.taskId, 'task-300');
    assert.equal(result.eventId, null);

    const taskRow = taskContinuationDb.getTaskById('task-300');
    assert.equal(taskRow?.status, 'completed');
  });
});

test('claimPendingEvent enforces lease isolation and handles expiration', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-400',
      userId: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      title: '抢占测试',
      autoNotify: true,
      tokenHash: 'hash-abc',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-400',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'hash-400',
      resultSummary: '完成',
    });
    const eventId = completion.eventId!;

    // Dispatcher A 领取事件，租约 10 秒
    const claimA = taskContinuationDb.claimPendingEvent({
      leaseOwner: 'dispatcher-A',
      leaseDurationMs: 10_000,
    });
    assert.ok(claimA);
    assert.equal(claimA.event_id, eventId);
    assert.equal(claimA.status, 'claimed');
    assert.equal(claimA.lease_owner, 'dispatcher-A');

    // Dispatcher B 尝试领取：此时由于租约有效，不能重复领取
    const claimB = taskContinuationDb.claimPendingEvent({
      leaseOwner: 'dispatcher-B',
      leaseDurationMs: 10_000,
    });
    assert.equal(claimB, null);

    // 过期 Dispatcher A 的租约（模拟超时/死机）
    taskContinuationDb.expireLeaseForTesting(eventId);

    // Dispatcher B 再次尝试领取：现在可以成功接管！
    const claimBRetry = taskContinuationDb.claimPendingEvent({
      leaseOwner: 'dispatcher-B',
      leaseDurationMs: 10_000,
    });
    assert.ok(claimBRetry);
    assert.equal(claimBRetry.event_id, eventId);
    assert.equal(claimBRetry.lease_owner, 'dispatcher-B');
  });
});

test('claimPendingEvent reclaims a production lease at the exact expiration time', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-iso-lease', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-iso-lease',
      userId: 1,
      sessionId: 'session-iso-lease',
      title: 'ISO 租约接管',
      autoNotify: true,
      tokenHash: 'hash-iso-lease',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-iso-lease',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'digest-iso-lease',
    });
    const eventId = completion.eventId!;

    const nowMs = Date.UTC(2026, 9, 17, 0, 0, 0);
    const firstClaim = taskContinuationDb.claimPendingEvent({
      leaseOwner: 'dispatcher-iso-a',
      leaseDurationMs: 60_000,
      nowMs,
    });
    assert.ok(firstClaim);
    const storedLease = getConnection().prepare(
      'SELECT lease_expires_at_ms FROM task_continuation_events WHERE event_id = ?',
    ).get(eventId) as { lease_expires_at_ms: number };
    assert.equal(storedLease.lease_expires_at_ms, nowMs + 60_000);

    const secondClaim = taskContinuationDb.claimPendingEvent({
      leaseOwner: 'dispatcher-iso-b',
      leaseDurationMs: 60_000,
      nowMs: nowMs + 60_000,
    });
    assert.equal(secondClaim?.event_id, eventId);
    assert.equal(secondClaim?.lease_owner, 'dispatcher-iso-b');
  });
});

test('database migration converts existing ISO lease values to millisecond timestamps', async () => {
  await withIsolatedDatabase(async () => {
    const legacyIsoLease = '2026-10-17T00:00:00.000Z';
    getConnection().prepare(`
      INSERT INTO async_tasks (
        task_id, user_id, session_id, title, auto_notify, status, token_hash
      ) VALUES ('task-legacy-lease', 1, 'session-legacy-lease', '旧租约', 1, 'completed', 'hash')
    `).run();
    getConnection().prepare(`
      INSERT INTO task_continuation_events (
        event_id, task_id, session_id, status, lease_expires_at, lease_expires_at_ms
      ) VALUES ('event-legacy-lease', 'task-legacy-lease', 'session-legacy-lease', 'claimed', ?, NULL)
    `).run(legacyIsoLease);

    runMigrations(getConnection());

    const migrated = getConnection().prepare(
      'SELECT lease_expires_at_ms FROM task_continuation_events WHERE event_id = ?',
    ).get('event-legacy-lease') as { lease_expires_at_ms: number };
    assert.ok(Math.abs(migrated.lease_expires_at_ms - Date.parse(legacyIsoLease)) < 10);
  });
});

test('continuation event lifecycle state transitions with lease owner check', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-500',
      userId: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      title: '状态机流转',
      autoNotify: true,
      tokenHash: 'hash-abc',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-500',
      status: 'completed',
      exitCode: 0,
      resultDigest: 'hash-500',
      resultSummary: '完成',
    });
    const eventId = completion.eventId!;

    assert.equal(taskContinuationDb.updateEventDelivered({ eventId, engineTurnId: 'turn-too-early' }), false);
    assert.equal(taskContinuationDb.getEventById(eventId)?.status, 'pending');

    // 领取
    taskContinuationDb.claimPendingEvent({
      leaseOwner: 'dispatcher-A',
      leaseDurationMs: 10_000,
    });

    // 非持有者试图更新 sending 状态：失败
    const wrongOwnerUpdate = taskContinuationDb.updateEventSending({
      eventId,
      leaseOwner: 'wrong-dispatcher',
      hostRunId: 'host-run-1',
    });
    assert.equal(wrongOwnerUpdate, false);

    // 正确持有者更新 sending
    const correctSending = taskContinuationDb.updateEventSending({
      eventId,
      leaseOwner: 'dispatcher-A',
      hostRunId: 'host-run-1',
    });
    assert.equal(correctSending, true);

    let row = taskContinuationDb.getEventById(eventId);
    assert.equal(row?.status, 'sending');
    assert.equal(row?.host_run_id, 'host-run-1');

    // 标记 accepted
    taskContinuationDb.updateEventAccepted({
      eventId,
      engineTurnId: 'turn-engine-1',
      hostRunId: 'host-run-1',
    });
    row = taskContinuationDb.getEventById(eventId);
    assert.equal(row?.status, 'accepted');
    assert.equal(row?.engine_turn_id, 'turn-engine-1');

    // 标记 delivered
    taskContinuationDb.updateEventDelivered({ eventId, engineTurnId: 'turn-engine-1' });
    row = taskContinuationDb.getEventById(eventId);
    assert.equal(row?.status, 'delivered');

    assert.equal(taskContinuationDb.updateEventFailed({
      eventId,
      error: '迟到的旧尝试结果',
      terminalStatus: 'reply_failed',
      expectedStatus: 'accepted',
      engineTurnId: 'turn-engine-1',
    }), false);
    assert.equal(taskContinuationDb.getEventById(eventId)?.status, 'delivered');
  });
});

test('manual retry returns needs_review to pending and records the confirming user and reason', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-manual-retry', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-manual-retry', userId: 1, sessionId: 'session-manual-retry',
      title: '复核后重投', autoNotify: true, tokenHash: 'hash-manual-retry',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-manual-retry', status: 'completed', exitCode: 0,
      resultDigest: 'digest-manual-retry', resultSummary: '完成',
    });
    const eventId = completion.eventId!;
    taskContinuationDb.claimEventById({ eventId, leaseOwner: 'first-attempt', leaseDurationMs: 10_000 });
    taskContinuationDb.updateEventSending({ eventId, leaseOwner: 'first-attempt', hostRunId: 'old-host-run' });
    taskContinuationDb.updateEventAccepted({ eventId, engineTurnId: 'old-engine-turn', hostRunId: 'old-host-run' });
    taskContinuationDb.updateEventFailed({
      eventId, error: 'History is incomplete.', terminalStatus: 'needs_review', expectedStatus: 'accepted',
      engineTurnId: 'old-engine-turn',
    });
    const priorReceipt = taskContinuationDb.getEventById(eventId)!;

    assert.equal(taskContinuationDb.manuallyRequeueEvent({
      eventId, userId: 1, reason: '我确认检查产物后接受重复执行风险。',
    }), true);
    assert.equal(taskContinuationDb.getEventById(eventId)?.status, 'pending');
    assert.match(taskContinuationDb.getEventById(eventId)?.last_error ?? '', /may already have run/i);
    const action = getConnection().prepare(
      'SELECT user_id, action, reason, previous_receipt_json FROM task_continuation_manual_actions WHERE event_id = ?',
    ).get(eventId) as { user_id: number; action: string; reason: string; previous_receipt_json: string };
    assert.deepEqual({ user_id: action.user_id, action: action.action, reason: action.reason }, {
      user_id: 1, action: 'retry_notification', reason: '我确认检查产物后接受重复执行风险。',
    });
    assert.deepEqual(JSON.parse(action.previous_receipt_json), {
      status: priorReceipt.status,
      attempts: priorReceipt.attempts,
      lastAttemptAt: priorReceipt.last_attempt_at,
      engineTurnId: priorReceipt.engine_turn_id,
      hostRunId: priorReceipt.host_run_id,
      lastError: priorReceipt.last_error,
      leaseOwner: priorReceipt.lease_owner,
      leaseExpiresAtMs: priorReceipt.lease_expires_at_ms,
    });
  });
});

test('cancelling a notification preserves task result and cannot revoke an accepted turn', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-cancel-notice', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-cancel-notice', userId: 1, sessionId: 'session-cancel-notice',
      title: '只取消汇报', autoNotify: true, tokenHash: 'hash-cancel-notice',
    });
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-cancel-notice', status: 'completed', exitCode: 0,
      resultDigest: 'digest-cancel-notice', resultSummary: '任务确已完成',
    });
    assert.equal(taskContinuationDb.cancelEvent({ eventId: completion.eventId!, reason: '用户取消未来汇报' }), true);
    assert.equal(taskContinuationDb.getEventById(completion.eventId!)?.status, 'cancelled');
    assert.equal(taskContinuationDb.getTaskById('task-cancel-notice')?.status, 'completed');

    taskContinuationDb.registerAsyncTask({
      taskId: 'task-cancel-notice-2', userId: 1, sessionId: 'session-cancel-notice',
      title: '已接受回合不可撤回', autoNotify: true, tokenHash: 'hash-cancel-notice-2',
    });
    const secondCompletion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-cancel-notice-2', status: 'completed', exitCode: 0,
      resultDigest: 'digest-cancel-notice-2', resultSummary: '第二项',
    });
    assert.ok(secondCompletion.eventId);
    assert.ok(taskContinuationDb.claimPendingEvent({ leaseOwner: 'cancel-test', leaseDurationMs: 10_000 }));
    assert.equal(taskContinuationDb.updateEventSending({
      eventId: secondCompletion.eventId!, leaseOwner: 'cancel-test', hostRunId: 'cancel-run',
    }), true);
    assert.equal(taskContinuationDb.updateEventAccepted({
      eventId: secondCompletion.eventId!, hostRunId: 'cancel-run', engineTurnId: 'engine-turn',
    }), true);
    assert.equal(taskContinuationDb.cancelEvent({ eventId: secondCompletion.eventId! }), false);
    assert.equal(taskContinuationDb.getEventById(secondCompletion.eventId!)?.status, 'accepted');
  });
});

test('cancelling before a running task finishes suppresses its future outbox event', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-cancel-before-result', 'codex', '/workspace/demo', 'Test Session');
    taskContinuationDb.registerAsyncTask({
      taskId: 'task-cancel-before-result', userId: 1, sessionId: 'session-cancel-before-result',
      title: '提前取消汇报', autoNotify: true, tokenHash: 'hash-cancel-before-result',
    });
    taskContinuationDb.markTaskRunning('task-cancel-before-result');
    assert.equal(taskContinuationDb.cancelNotificationForTask('task-cancel-before-result'), 'cancelled');
    const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: 'task-cancel-before-result', status: 'completed', exitCode: 0,
      resultDigest: 'digest-cancel-before-result', resultSummary: '任务继续完成',
    });
    assert.equal(completion.eventId, null);
    assert.equal(taskContinuationDb.getTaskById('task-cancel-before-result')?.status, 'completed');
  });
});

test('pending work from another chat moves ahead of a chat that just yielded as busy', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-fair-a', 'codex', '/workspace/demo', 'Busy chat');
    sessionsDb.createSession('session-fair-b', 'codex', '/workspace/demo', 'Other chat');
    for (const [taskId, sessionId] of [
      ['task-fair-a', 'session-fair-a'], ['task-fair-b', 'session-fair-b'],
    ]) {
      taskContinuationDb.registerAsyncTask({
        taskId, userId: 1, sessionId, title: taskId, autoNotify: true, tokenHash: `hash-${taskId}`,
      });
      taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
        taskId, status: 'completed', exitCode: 0, resultDigest: `digest-${taskId}`, resultSummary: '完成',
      });
    }
    const first = taskContinuationDb.claimPendingEvent({ leaseOwner: 'fair-worker', leaseDurationMs: 10_000 });
    assert.equal(first?.session_id, 'session-fair-a');
    assert.equal(taskContinuationDb.releaseClaimedEvent({ eventId: first!.event_id, leaseOwner: 'fair-worker' }), true);
    const next = taskContinuationDb.claimPendingEvent({ leaseOwner: 'fair-worker', leaseDurationMs: 10_000 });
    assert.equal(next?.session_id, 'session-fair-b');
  });
});

test('pending events preserve per-chat enqueue order while allowing other chats to progress', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-order-a', 'codex', '/workspace/demo', 'Ordered chat');
    sessionsDb.createSession('session-order-b', 'codex', '/workspace/demo', 'Independent chat');
    const completions = new Map<string, string>();
    for (const [taskId, sessionId] of [
      ['task-order-a1', 'session-order-a'],
      ['task-order-a2', 'session-order-a'],
      ['task-order-b1', 'session-order-b'],
    ]) {
      taskContinuationDb.registerAsyncTask({ taskId, userId: 1, sessionId, title: taskId, autoNotify: true, tokenHash: `hash-${taskId}` });
      completions.set(taskId, taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
        taskId, status: 'completed', exitCode: 0, resultDigest: `digest-${taskId}`, resultSummary: 'done',
      }).eventId!);
    }
    getConnection().prepare(`UPDATE task_continuation_events SET created_at = '2026-10-17 00:00:00'`).run();
    const earlier = taskContinuationDb.claimPendingEvent({ leaseOwner: 'order-test', leaseDurationMs: 10_000 });
    assert.equal(earlier?.event_id, completions.get('task-order-a1'));
    assert.equal(taskContinuationDb.updateEventSending({ eventId: earlier!.event_id, leaseOwner: 'order-test', hostRunId: 'order-run' }), true);
    assert.equal(taskContinuationDb.updateEventAccepted({ eventId: earlier!.event_id, engineTurnId: 'turn-a1', hostRunId: 'order-run' }), true);

    const independent = taskContinuationDb.claimPendingEvent({ leaseOwner: 'order-test-2', leaseDurationMs: 10_000 });
    assert.equal(independent?.event_id, completions.get('task-order-b1'));
    assert.equal(taskContinuationDb.getEventById(completions.get('task-order-a2')!)?.status, 'pending');
    assert.equal(taskContinuationDb.claimPendingEvent({ leaseOwner: 'order-test-3', leaseDurationMs: 10_000 }), null);

    taskContinuationDb.updateEventDelivered({ eventId: earlier!.event_id, engineTurnId: 'turn-a1' });
    const nextInChat = taskContinuationDb.claimPendingEvent({ leaseOwner: 'order-test-4', leaseDurationMs: 10_000 });
    assert.equal(nextInChat?.event_id, completions.get('task-order-a2'));
  });
});

test('initializeDatabase upgrades an existing async_tasks table before creating new-column indexes', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-legacy-startup-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  await writeFile(databasePath, '');
  const legacyDb = new Database(databasePath);
  legacyDb.exec(`
    CREATE TABLE async_tasks (
      task_id TEXT PRIMARY KEY NOT NULL,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      command TEXT,
      auto_notify BOOLEAN DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'registered',
      exit_code INTEGER,
      result_digest TEXT,
      result_path TEXT,
      result_summary TEXT,
      result_json TEXT,
      token_hash TEXT NOT NULL,
      token_expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacyDb.close();

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  try {
    await initializeDatabase();
    const columns = (getConnection().prepare('PRAGMA table_info(async_tasks)').all() as Array<{ name: string }>).map(({ name }) => name);
    assert.ok(columns.includes('registration_key'));
    const index = getConnection().prepare('PRAGMA index_info(idx_async_tasks_registration_key)').all() as Array<{ name: string }>;
    assert.deepEqual(index.map(({ name }) => name), ['registration_key']);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

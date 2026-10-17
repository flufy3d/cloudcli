import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import {
  generateTaskCallbackToken,
  hashToken,
  verifyTaskCallbackToken,
} from '@/modules/task-continuations/services/task-token.service.js';
import {
  handleGetTaskStatus,
  handleTaskFinishRequest,
  handleTaskRegisterRequest,
} from '@/modules/task-continuations/task-continuations.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-routes-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  await writeFile(databasePath, '');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

test('generateTaskCallbackToken and hashToken verify correctly and reject bad tokens', () => {
  const token = generateTaskCallbackToken('task-abc');
  const hashed = hashToken(token);

  assert.equal(verifyTaskCallbackToken(token, hashed), true);
  assert.equal(verifyTaskCallbackToken('wrong-token', hashed), false);
});

test('handleTaskRegisterRequest registers task and returns valid callback token', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');

    const result = await handleTaskRegisterRequest({
      userId: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      title: '单元测试任务',
      command: 'npm test',
      autoNotify: true,
    });

    assert.ok(result.taskId.startsWith('task_'));
    assert.ok(result.taskToken);
    assert.equal(result.title, '单元测试任务');
  });
});

test('task registration returns the original task for a repeated host request identity', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-idempotency', 'codex', '/workspace/demo', 'Idempotent task session');
    const input = {
      userId: 1,
      sessionId: 'session-idempotency',
      runId: 'run-idempotency',
      title: '幂等登记',
      registrationKey: 'sha256:stable-host-request-identity',
    };

    const first = await handleTaskRegisterRequest(input);
    const repeated = await handleTaskRegisterRequest(input);

    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    assert.equal(repeated.taskId, first.taskId);
    assert.equal(repeated.taskToken, null);
    await assert.rejects(
      handleTaskRegisterRequest({ ...input, command: '["node","-e","different"]' }),
      (error: any) => error.code === 'TASK_REGISTRATION_IDENTITY_CONFLICT' && error.statusCode === 409,
    );
  });
});

test('task status lookup rejects a different user and session owner', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-owner', 'codex', '/workspace/demo', 'Owner session');
    const registered = await handleTaskRegisterRequest({
      userId: 1,
      sessionId: 'session-owner',
      runId: 'run-owner',
      title: '所有权校验',
    });

    await assert.rejects(
      handleGetTaskStatus(registered.taskId, { userId: 2, sessionId: 'session-owner' }),
      (error: any) => error.code === 'TASK_NOT_FOUND' && error.statusCode === 404,
    );
    await assert.rejects(
      handleGetTaskStatus(registered.taskId, { userId: 1, sessionId: 'other-session' }),
      (error: any) => error.code === 'TASK_NOT_FOUND' && error.statusCode === 404,
    );
  });
});

test('handleTaskFinishRequest accepts valid callback token and dual-writes outbox', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');

    const registered = await handleTaskRegisterRequest({
      userId: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      title: '单元测试任务',
      autoNotify: true,
    });

    const finishResult = await handleTaskFinishRequest({
      taskId: registered.taskId,
      taskToken: registered.taskToken!,
      status: 'completed',
      exitCode: 0,
      resultDigest: 'digest-12345',
      resultSummary: '测试全部通过',
    });

    assert.equal(finishResult.success, true);
    assert.equal(finishResult.isDuplicate, false);
    assert.ok(finishResult.eventId);

    // 错误凭证被拒绝
    await assert.rejects(
      async () => {
        await handleTaskFinishRequest({
          taskId: registered.taskId,
          taskToken: 'invalid-token',
          status: 'completed',
          resultDigest: 'digest-12345',
        });
      },
      (err: any) => err.code === 'INVALID_TASK_TOKEN',
    );
  });
});

test('handleTaskFinishRequest detects path traversal and rejects unsafe paths', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-1', 'codex', '/workspace/demo', 'Test Session');

    const registered = await handleTaskRegisterRequest({
      userId: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      title: '路径穿越测试',
      autoNotify: true,
    });

    await assert.rejects(
      async () => {
        await handleTaskFinishRequest({
          taskId: registered.taskId,
          taskToken: registered.taskToken!,
          status: 'completed',
          resultDigest: 'digest-traversal',
          resultPath: '../../../etc/passwd',
        });
      },
      (err: any) => err.code === 'UNSAFE_RESULT_PATH',
    );
  });
});

test('expired task callback credentials cannot submit a result', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-expired', 'codex', '/workspace/demo', 'Test Session');
    const registered = await handleTaskRegisterRequest({
      userId: 1,
      sessionId: 'session-expired',
      runId: 'run-expired',
      title: '过期回调凭证',
      autoNotify: true,
    });
    getConnection().prepare('UPDATE async_tasks SET token_expires_at = ? WHERE task_id = ?')
      .run('2000-01-01T00:00:00.000Z', registered.taskId);

    await assert.rejects(
      handleTaskFinishRequest({
        taskId: registered.taskId,
        taskToken: registered.taskToken!,
        status: 'completed',
        exitCode: 0,
        resultDigest: 'attacker-controlled-digest',
        resultSummary: '已完成',
        resultJson: '{"version":1,"taskId":"ignored"}',
      }),
      (error: any) => error.code === 'TASK_TOKEN_EXPIRED',
    );
  });
});

test('task finish computes its digest from result data instead of trusting the callback', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('session-digest', 'codex', '/workspace/demo', 'Test Session');
    const registered = await handleTaskRegisterRequest({
      userId: 1,
      sessionId: 'session-digest',
      runId: 'run-digest',
      title: '摘要边界',
      autoNotify: true,
    });
    const resultJson = JSON.stringify({
      version: 1,
      taskId: registered.taskId,
      status: 'completed',
      exitCode: 0,
      summary: '已完成',
    });

    await handleTaskFinishRequest({
      taskId: registered.taskId,
      taskToken: registered.taskToken!,
      status: 'completed',
      exitCode: 0,
      resultDigest: 'attacker-controlled-digest',
      resultSummary: '已完成',
      resultJson,
    });

    const savedTask = (await import('@/modules/database/index.js')).taskContinuationDb.getTaskById(registered.taskId);
    const normalizedResultJson = JSON.stringify({
      exitCode: 0,
      status: 'completed',
      summary: '已完成',
      taskId: registered.taskId,
      version: 1,
    });
    const expectedDigest = crypto.createHash('sha256').update(normalizedResultJson).digest('hex');
    assert.equal(savedTask?.result_digest, expectedDigest);
    assert.notEqual(savedTask?.result_digest, 'attacker-controlled-digest');

    await assert.rejects(
      handleTaskFinishRequest({
        taskId: registered.taskId,
        taskToken: registered.taskToken!,
        status: 'completed',
        exitCode: 0,
        resultDigest: 'attacker-controlled-digest',
        resultSummary: '已完成',
        resultJson: JSON.stringify({
          version: 1,
          taskId: registered.taskId,
          status: 'completed',
          exitCode: 0,
          summary: '已完成',
          artifact: '/tmp/changed-output.txt',
        }),
      }),
      (error: any) => error.code === 'TASK_RESULT_CONFLICT',
    );
  });
});

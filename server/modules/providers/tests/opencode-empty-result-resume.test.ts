import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  buildOpenCodeResumeMessage,
  shouldResumeOpenCodeTurn,
} from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import {
  OpenCodeSessionsProvider,
  readOpenCodeTaskDelivery,
} from '@/modules/providers/list/opencode/opencode-sessions.provider.js';

const emptyTaskOutput = '<task id="ses_sub_child" state="completed">\n<task_result>\n\n</task_result>\n</task>';
const deliveredTaskOutput = '<task id="ses_sub_child" state="completed">\n<task_result>\ndufu.js written, tsc clean\n</task_result>\n</task>';

const taskPart = ({ output, status = 'completed' }: { output: string; status?: string }) => ({
  id: 'part-task-1',
  type: 'tool',
  tool: 'task',
  callID: 'call-task-1',
  state: {
    status,
    input: { description: 'dufu.js 调度器实现', subagent_type: 'general' },
    output,
  },
});

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

test('a completed task part with an empty result reads as an empty delivery', () => {
  assert.deepEqual(readOpenCodeTaskDelivery(taskPart({ output: emptyTaskOutput })), {
    empty: true,
    taskId: 'ses_sub_child',
    description: 'dufu.js 调度器实现',
  });
});

test('a completed task part with real text is not an empty delivery', () => {
  const delivery = readOpenCodeTaskDelivery(taskPart({ output: deliveredTaskOutput }));
  assert.equal(delivery?.empty, false);
});

test('running task parts, other tools and unpackable parts are not deliveries', () => {
  assert.equal(readOpenCodeTaskDelivery(taskPart({ output: emptyTaskOutput, status: 'running' })), null);
  assert.equal(
    readOpenCodeTaskDelivery({ tool: 'bash', state: { status: 'completed', output: 'ok' } }),
    null,
  );
  assert.equal(readOpenCodeTaskDelivery({ tool: 'task', state: { status: 'completed', output: 'no envelope' } }), null);
  assert.equal(readOpenCodeTaskDelivery(null), null);
});

test('the live stream reports an empty subagent result as a failed card', () => {
  const provider = new OpenCodeSessionsProvider();

  const normalized = provider.normalizeMessage({
    type: 'tool_use',
    sessionID: 'open-session-live',
    part: taskPart({ output: emptyTaskOutput }),
  }, null);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.toolName, 'task');
  assert.equal(normalized[0]?.toolResult?.isError, true);
  assert.match(String(normalized[0]?.toolResult?.content), /empty result/);

  const delivered = provider.normalizeMessage({
    type: 'tool_use',
    sessionID: 'open-session-live',
    part: taskPart({ output: deliveredTaskOutput }),
  }, null);
  assert.equal(delivered[0]?.toolResult?.isError, false);
});

test('history reports an empty subagent result as a failed card too', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-empty-delivery-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  const previousDatabasePath = process.env.DATABASE_PATH;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );

        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
        .run(
          'msg-task',
          'open-task-session',
          1_700_000_001_000,
          1_700_000_002_000,
          JSON.stringify({ role: 'assistant', time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 } }),
        );
      const { id, type, tool, callID, state } = taskPart({ output: emptyTaskOutput });
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'msg-task', 'open-task-session', 1_700_000_002_000, 1_700_000_002_000, JSON.stringify({ type, tool, callID, state }));
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-task-session');
    const card = history.messages.find((message) => message.kind === 'tool_use');
    assert.ok(card, 'the task card must survive a history reload');
    assert.equal(card.toolResult?.isError, true);
    assert.match(String(card.toolResult?.content), /empty result/);
  } finally {
    restoreHomeDir();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const baseResumeSignals = {
  hasPrompt: true,
  aborted: false,
  failed: false,
  attempted: false,
  emptyDeliveries: [] as Array<{ empty: boolean; taskId: string | null; description: string | null }>,
  toolPartCount: 1,
  sawAssistantText: true,
};

test('an empty subagent delivery resumes the turn once', () => {
  assert.equal(
    shouldResumeOpenCodeTurn({
      ...baseResumeSignals,
      emptyDeliveries: [{ empty: true, taskId: 'ses_x', description: 'x' }],
    }),
    true,
  );
});

test('a whole-empty turn resumes; a turn that did anything does not', () => {
  assert.equal(shouldResumeOpenCodeTurn({ ...baseResumeSignals, toolPartCount: 0, sawAssistantText: false }), true);
  assert.equal(shouldResumeOpenCodeTurn({ ...baseResumeSignals, toolPartCount: 0, sawAssistantText: true }), false);
  assert.equal(shouldResumeOpenCodeTurn({ ...baseResumeSignals, toolPartCount: 2, sawAssistantText: false }), false);
});

test('aborted, failed, attempted and prompt-less runs never resume', () => {
  const empty = {
    ...baseResumeSignals,
    emptyDeliveries: [{ empty: true, taskId: null, description: null }],
  };
  assert.equal(shouldResumeOpenCodeTurn({ ...empty, aborted: true }), false);
  assert.equal(shouldResumeOpenCodeTurn({ ...empty, failed: true }), false);
  assert.equal(shouldResumeOpenCodeTurn({ ...empty, attempted: true }), false);
  assert.equal(shouldResumeOpenCodeTurn({ ...empty, hasPrompt: false }), false);
});

test('the resume message names the empty subagent and its task id', () => {
  const forSubagent = buildOpenCodeResumeMessage({
    emptyDeliveries: [{ description: 'dufu.js 调度器实现', taskId: 'ses_child_1' }],
  });
  assert.ok(forSubagent.includes('[cloudcli auto-retry]'));
  assert.ok(forSubagent.includes('"dufu.js 调度器实现"'));
  assert.ok(forSubagent.includes('task_id ses_child_1'));

  const forEmptyTurn = buildOpenCodeResumeMessage({ emptyDeliveries: [] });
  assert.ok(forEmptyTurn.includes('without any output'));
});

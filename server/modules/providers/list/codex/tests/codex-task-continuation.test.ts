import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexThreadItemToRows,
  readCodexAppServerItem,
  readCodexRolloutItem,
} from '@/modules/providers/list/codex/codex-thread-items.js';

test('readCodexAppServerItem parses FunctionCallOutput for task continuation', () => {
  const payload = {
    id: 'fco_test_123',
    type: 'functionCallOutput',
    name: 'cloudcli_task_result',
    output: JSON.stringify({
      eventId: 'evt-100',
      taskId: 'task-100',
      status: 'completed',
      summary: '后台编译成功完成',
    }),
  };

  const item = readCodexAppServerItem(payload);
  assert.ok(item);
  assert.equal(item.kind, 'task_result');
  assert.equal(item.id, 'fco_test_123');
  assert.equal(item.name, 'cloudcli_task_result');
  assert.ok(item.output.includes('后台编译成功完成'));
});

test('readCodexRolloutItem parses rollout FunctionCallOutput item', () => {
  const payload = {
    id: 'fco_rollout_456',
    type: 'FunctionCallOutput',
    name: 'cloudcli_task_result',
    output: JSON.stringify({
      eventId: 'evt-200',
      taskId: 'task-200',
      status: 'failed',
      summary: '单元测试失败',
    }),
  };

  const item = readCodexRolloutItem(payload);
  assert.ok(item);
  assert.equal(item.kind, 'task_result');
  assert.equal(item.id, 'fco_rollout_456');
  assert.equal(item.name, 'cloudcli_task_result');
});

test('ordinary function call outputs are not mislabeled as async task notifications', () => {
  assert.equal(readCodexAppServerItem({
    id: 'fco_other_live', type: 'functionCallOutput', name: 'some_other_tool', output: 'ordinary output',
  }), null);
  assert.equal(readCodexRolloutItem({
    id: 'fco_other_history', type: 'FunctionCallOutput', name: 'some_other_tool', output: 'ordinary output',
  }), null);
});

test('codexThreadItemToRows maps task_result to status_note without stray tool cards or fake user message', () => {
  const item: any = {
    kind: 'task_result',
    id: 'fco_test_789',
    name: 'cloudcli_task_result',
    output: JSON.stringify({
      eventId: 'evt-300',
      taskId: 'task-300',
      status: 'completed',
      summary: '复核完成，所有指标达标',
    }),
  };

  const rows = codexThreadItemToRows(item, '2026-10-17T04:00:00.000Z');
  assert.equal(rows.length, 1);
  const row = rows[0];

  assert.equal(row.uuid, 'fco_test_789');
  assert.equal(row.type, 'status_note');
  assert.equal(row.content, '复核完成，所有指标达标');
  assert.notEqual(row.type, 'user');
  assert.notEqual(row.type, 'tool_use');
});

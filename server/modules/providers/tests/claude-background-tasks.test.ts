import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBackgroundStripSettler,
  extractBackgroundTasks,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

test('extracts background tasks from Bash tool with run_in_background: true', () => {
  const message = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_bash_1',
          name: 'Bash',
          input: {
            command: 'npm run test',
            run_in_background: true,
          },
        },
      ],
    },
  };

  const tasks = extractBackgroundTasks(message);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'toolu_bash_1');
  assert.equal(tasks[0].toolName, 'Bash');
  assert.equal(tasks[0].command, 'npm run test');
  assert.ok(typeof tasks[0].startedAt === 'number');
});

test('ignores Bash tool without run_in_background: true', () => {
  const message = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_bash_2',
          name: 'Bash',
          input: {
            command: 'ls -la',
          },
        },
      ],
    },
  };

  const tasks = extractBackgroundTasks(message);
  assert.equal(tasks.length, 0);
});

test('extracts background tasks from deferred work tools like Monitor', () => {
  const message = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_task_1',
          name: 'Monitor',
          input: {
            description: 'Run background analysis',
          },
        },
      ],
    },
  };

  const tasks = extractBackgroundTasks(message);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'toolu_task_1');
  assert.equal(tasks[0].toolName, 'Monitor');
  assert.equal(tasks[0].command, 'Run background analysis');
});

test('TaskCreate only writes a to-do item and creates no running-task card', () => {
  assert.deepEqual(extractBackgroundTasks({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_todo', name: 'TaskCreate', input: { subject: 'Plan work' } }] },
  }), []);
});

test('returns empty array when content has no tool use or non-array content', () => {
  assert.deepEqual(extractBackgroundTasks({ type: 'user', message: { content: 'hello' } }), []);
  assert.deepEqual(extractBackgroundTasks(null), []);
});

const stripEntry = (id: string, toolName = 'Agent') => ({ id, toolName, command: id, startedAt: 1 });
const taskEvent = (subtype: string, fields: Record<string, unknown>) => ({ type: 'system', subtype, session_id: 'native', ...fields });

test('strip settler retires an entry by task id when the event names no call', () => {
  const strip = new Map([['toolu_agent', stripEntry('toolu_agent')], ['toolu_bash', stripEntry('toolu_bash', 'Bash')]]);
  const settle = createBackgroundStripSettler(strip);

  assert.equal(settle(taskEvent('task_started', { task_id: 't_agent', tool_use_id: 'toolu_agent', is_backgrounded: true })), false);
  assert.equal(settle(taskEvent('task_started', { task_id: 't_bash', tool_use_id: 'toolu_bash', is_backgrounded: true })), false);
  assert.equal(settle(taskEvent('task_updated', { task_id: 't_agent', patch: { status: 'running' } })), false);

  // A terminal task_updated carries only the task id.
  assert.equal(settle(taskEvent('task_updated', { task_id: 't_agent', patch: { status: 'killed' } })), true);
  // A notification without tool_use_id still finds its call.
  assert.equal(settle(taskEvent('task_notification', { task_id: 't_bash', status: 'completed' })), true);
  assert.equal(strip.size, 0);
});

test('strip settler parks a foreground task and restores it when moved to the background', () => {
  const strip = new Map([['toolu_agent', stripEntry('toolu_agent')]]);
  const settle = createBackgroundStripSettler(strip);

  assert.equal(settle(taskEvent('task_started', { task_id: 't1', tool_use_id: 'toolu_agent', is_backgrounded: false })), true);
  assert.equal(strip.size, 0, 'a foreground agent is not background work');

  assert.equal(settle(taskEvent('task_updated', { task_id: 't1', patch: { is_backgrounded: true } })), true);
  assert.deepEqual([...strip.keys()], ['toolu_agent']);

  assert.equal(settle(taskEvent('task_notification', { task_id: 't1', tool_use_id: 'toolu_agent', status: 'completed' })), true);
  assert.equal(strip.size, 0);
});

test('strip settler ignores tasks the strip never listed', () => {
  const strip = new Map([['toolu_agent', stripEntry('toolu_agent')]]);
  const settle = createBackgroundStripSettler(strip);

  assert.equal(settle(taskEvent('task_started', { task_id: 't_nested', tool_use_id: 'toolu_nested', is_backgrounded: false })), false);
  assert.equal(settle(taskEvent('task_notification', { task_id: 't_nested', tool_use_id: 'toolu_nested', status: 'completed' })), false);
  assert.equal(settle(taskEvent('task_updated', { task_id: 't_unknown', patch: { status: 'completed' } })), false);
  assert.equal(settle({ type: 'assistant', message: { content: [] } }), false);
  assert.deepEqual([...strip.keys()], ['toolu_agent']);
});

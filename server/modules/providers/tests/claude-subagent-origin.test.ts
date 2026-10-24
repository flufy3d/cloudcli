import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubagentOriginTracker } from '@/modules/providers/list/claude/claude-subagent-origin.js';

const assistant = (blocks: Array<Record<string, unknown>>, parent?: string) => ({
  type: 'assistant',
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: blocks.map((block) => ({ type: 'tool_use', input: {}, ...block })) },
});

test('a tool call made inside an agent is attributed to that agent\'s card', () => {
  const tracker = createSubagentOriginTracker();
  tracker.observe(assistant([{ id: 'toolu_agent', name: 'Agent', input: { description: 'Review the diff', prompt: 'go' } }]));
  tracker.observe(assistant([{ id: 'toolu_child', name: 'Bash', input: { command: 'ls' } }], 'toolu_agent'));

  assert.deepEqual(tracker.originOf('toolu_child'), { toolUseId: 'toolu_agent', description: 'Review the diff' });
});

test('a main-thread call has no origin', () => {
  const tracker = createSubagentOriginTracker();
  tracker.observe(assistant([{ id: 'toolu_main', name: 'Bash' }]));
  assert.equal(tracker.originOf('toolu_main'), undefined);
  assert.equal(tracker.originOf('toolu_unknown'), undefined);
  assert.equal(tracker.originOf(undefined), undefined);
});

test('a call inside a nested agent resolves to the outermost card', () => {
  const tracker = createSubagentOriginTracker();
  tracker.observe(assistant([{ id: 'toolu_outer', name: 'Agent', input: { description: 'Outer' } }]));
  tracker.observe(assistant([{ id: 'toolu_inner', name: 'Agent', input: { description: 'Inner' } }], 'toolu_outer'));
  tracker.observe(assistant([{ id: 'toolu_deep', name: 'Read' }], 'toolu_inner'));

  assert.deepEqual(tracker.originOf('toolu_deep'), { toolUseId: 'toolu_outer', description: 'Outer' });
});

test('the legacy Task name is an agent call too, and an agent with no description still names its card', () => {
  const tracker = createSubagentOriginTracker();
  tracker.observe(assistant([{ id: 'toolu_task', name: 'Task', input: { prompt: 'Look around\nmore' } }]));
  tracker.observe(assistant([{ id: 'toolu_child', name: 'Read' }], 'toolu_task'));
  assert.deepEqual(tracker.originOf('toolu_child'), { toolUseId: 'toolu_task', description: 'Look around' });
});

test('a request that beats the stream waits for its tool call to be seen, then finds the origin', async () => {
  const tracker = createSubagentOriginTracker();
  tracker.observe(assistant([{ id: 'toolu_agent', name: 'Agent', input: { description: 'Review' } }]));

  const waiting = tracker.whenObserved('toolu_child', 1_000);
  assert.equal(tracker.originOf('toolu_child'), undefined, 'not known yet');
  tracker.observe(assistant([{ id: 'toolu_child', name: 'Bash' }], 'toolu_agent'));
  await waiting;
  assert.deepEqual(tracker.originOf('toolu_child'), { toolUseId: 'toolu_agent', description: 'Review' });
});

test('waiting for a call already seen, or one that never shows, does not hang', async () => {
  const tracker = createSubagentOriginTracker();
  tracker.observe(assistant([{ id: 'toolu_main', name: 'Bash' }]));
  await tracker.whenObserved('toolu_main', 1_000);
  const started = Date.now();
  await tracker.whenObserved('toolu_ghost', 50);
  assert.ok(Date.now() - started < 500);
  await tracker.whenObserved(undefined, 50);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { BackgroundWorkRegistry } from '@/modules/providers/shared/background-work/background-work-registry.js';

const agent = { taskId: 'agent_1', toolUseId: 'call_1', taskType: 'local_agent', description: 'Review' };

test('a re-recorded start keeps the original startedAt so elapsed time does not jump', () => {
  const registry = new BackgroundWorkRegistry();
  const first = registry.start('sess_a', { ...agent, startedAt: 1_000 });
  const again = registry.start('sess_a', { ...agent, description: 'Review (renamed)', startedAt: 9_000 });

  assert.equal(first.startedAt, 1_000);
  assert.equal(again.startedAt, 1_000);
  assert.equal(again.description, 'Review (renamed)');
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].tasks.length, 1);
});

test('ending an agent nobody recorded is a no-op, not an error', () => {
  const registry = new BackgroundWorkRegistry();
  registry.start('sess_a', agent);

  assert.equal(registry.end('sess_a', 'agent_unknown'), undefined);
  assert.equal(registry.end('sess_other', 'agent_1'), undefined);
  assert.deepEqual(registry.list().map((entry) => entry.sessionId), ['sess_a']);

  const recorded = registry.get('sess_a', 'agent_1');
  assert.deepEqual(registry.end('sess_a', 'agent_1'), recorded);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.hasSession('sess_a'), false);
});

test('an agent is found across sessions by its id and cleared with its session', () => {
  const registry = new BackgroundWorkRegistry();
  registry.start('sess_a', agent);
  registry.start('sess_b', { ...agent, taskId: 'agent_2', toolUseId: 'call_2' });

  assert.equal(registry.has('agent_2'), true);
  assert.equal(registry.find('agent_2')?.sessionKey, 'sess_b');
  assert.equal(registry.get('sess_a', 'agent_2'), undefined);
  assert.equal(registry.get('sess_b', 'agent_2')?.toolUseId, 'call_2');

  registry.clearSession('sess_b');
  assert.equal(registry.has('agent_2'), false);
  assert.equal(registry.has('agent_1'), true);
  assert.deepEqual(registry.list().map((entry) => entry.sessionId), ['sess_a']);
});

test('the strip lists a session\'s agents by their cards, with no stop handle', () => {
  const registry = new BackgroundWorkRegistry();
  registry.start('sess_a', { ...agent, startedAt: 1_000 });
  registry.start('sess_b', { ...agent, taskId: 'agent_2', toolUseId: 'call_2' });

  // No `taskId`: the strip offers a per-task stop only for a handle the
  // runtime can stop, and these runtimes cannot stop one agent on its own.
  assert.deepEqual(registry.listStripTasks('sess_a'), [
    { id: 'call_1', toolName: 'Agent', command: 'Review', description: 'Review', startedAt: 1_000 },
  ]);
  assert.deepEqual(registry.listStripTasks('sess_none'), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentTranscriptTail } from '@/modules/providers/list/antigravity/antigravity-agent-tail.js';
import type { NormalizedMessage } from '@/shared/types.js';

const row = (fields: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'id' | 'kind'>): NormalizedMessage => ({
  sessionId: 'child', provider: 'antigravity', timestamp: '2026-01-01T00:00:00.000Z', ...fields,
} as NormalizedMessage);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('new steps of a followed agent are sent once, tied to its card', async () => {
  const timeline: NormalizedMessage[] = [row({ id: 'a', kind: 'tool_use', toolName: 'view_file', toolId: 't1' })];
  const sent: NormalizedMessage[] = [];
  const tail = createAgentTranscriptTail({ readTimeline: async () => [...timeline], emit: (message) => sent.push(message), intervalMs: 20 });

  tail.follow('conv-1', 'tool_3:conv-1');
  await wait(60);
  assert.deepEqual(sent.map((message) => [message.id, message.parentToolUseId]), [['a', 'tool_3:conv-1']]);

  timeline.push(row({ id: 'b', kind: 'text', role: 'assistant', content: 'Found it.' }));
  await wait(60);
  assert.deepEqual(sent.map((message) => message.id), ['a', 'b'], 'the unchanged first step is not sent again');
  await tail.stopAll();
});

test('a step whose result arrived later is sent again with it', async () => {
  const timeline: NormalizedMessage[] = [row({ id: 'a', kind: 'tool_use', toolName: 'run_command', toolId: 't1' })];
  const sent: NormalizedMessage[] = [];
  const tail = createAgentTranscriptTail({ readTimeline: async () => timeline.map((entry) => ({ ...entry })), emit: (message) => sent.push(message), intervalMs: 20 });

  tail.follow('conv-1', 'card');
  await wait(60);
  timeline[0] = { ...timeline[0], toolResult: { content: 'ok', isError: false } };
  await wait(60);

  assert.equal(sent.length, 2);
  assert.equal(sent[1].toolResult?.content, 'ok');
  await tail.stopAll();
});

test('stopping flushes what the agent did last and ends the polling', async () => {
  const timeline: NormalizedMessage[] = [];
  const sent: NormalizedMessage[] = [];
  let reads = 0;
  const tail = createAgentTranscriptTail({ readTimeline: async () => { reads += 1; return [...timeline]; }, emit: (message) => sent.push(message), intervalMs: 5_000 });

  tail.follow('conv-1', 'card');
  timeline.push(row({ id: 'late', kind: 'text', role: 'assistant', content: 'Done.' }));
  await tail.stop('conv-1');
  assert.deepEqual(sent.map((message) => message.id), ['late']);

  const readsAtStop = reads;
  await wait(50);
  assert.equal(reads, readsAtStop);
});

test('only an agent\'s tool calls and prose are sent, not its prompt or bookkeeping', async () => {
  const timeline = [
    row({ id: 'u', kind: 'text', role: 'user', content: 'the prompt' }),
    row({ id: 'c', kind: 'complete' }),
    row({ id: 't', kind: 'thinking', content: 'hmm' }),
    row({ id: 'x', kind: 'text', role: 'assistant', content: 'result' }),
  ];
  const sent: NormalizedMessage[] = [];
  const tail = createAgentTranscriptTail({ readTimeline: async () => timeline, emit: (message) => sent.push(message), intervalMs: 20 });
  tail.follow('conv-1', 'card');
  await wait(60);
  assert.deepEqual(sent.map((message) => message.id), ['t', 'x']);
  await tail.stopAll();
});

test('a failing read is logged and does not stop the following', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  let calls = 0;
  const sent: NormalizedMessage[] = [];
  const tail = createAgentTranscriptTail({
    readTimeline: async () => { calls += 1; if (calls === 1) throw new Error('disk hiccup'); return [row({ id: 'a', kind: 'text', role: 'assistant', content: 'ok' })]; },
    emit: (message) => sent.push(message), intervalMs: 20,
  });
  tail.follow('conv-1', 'card');
  await wait(100);
  assert.equal(warnings.length, 1);
  assert.deepEqual(sent.map((message) => message.id), ['a']);
  await tail.stopAll();
});

test('an agent with an unusable conversation id is reported once and never polled', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  let reads = 0;
  const tail = createAgentTranscriptTail({ readTimeline: async () => { reads += 1; return []; }, emit: () => {}, intervalMs: 20 });

  tail.follow('../escape', 'card');
  tail.follow('../escape', 'card');
  await wait(100);

  assert.equal(reads, 0);
  assert.equal(warnings.length, 1);
  await tail.stopAll();
});

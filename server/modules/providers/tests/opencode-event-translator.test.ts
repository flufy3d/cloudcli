import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenCodeSessionEventTranslator } from '@/modules/providers/list/opencode/opencode-event-translator.js';
import type { OpenCodeEventEnvelope } from '@/modules/providers/list/opencode/opencode-event-stream.js';
import { isVolatileMessageId } from '../../../../shared/protocol/messageKinds.js';

const SESSION = 'app-session-1';
const PROVIDER_SESSION = 'ses_eb857a8d8ffed2cSYbbA95gDcl';
const MESSAGE = 'msg_147a85cab001uo8epROih4QC82';
const CALL = 'call-2b478272-4258-4cc0-94f6-8cb4b18b658c';

/** Event shapes captured verbatim from opencode v2.0.31 (`temp/opencode-probe3-events.json`). */
const event = (type: string, data: Record<string, unknown>, extra: Partial<OpenCodeEventEnvelope> = {}): OpenCodeEventEnvelope => ({
  id: `evt_${type}`,
  created: 1792203579833,
  type,
  location: { directory: '/tmp/project' },
  data: { sessionID: PROVIDER_SESSION, ...data },
  ...extra,
});

test('streams text as stream_delta frames and closes each segment with stream_end', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);

  const started = translator.translate(event('session.text.started', { assistantMessageID: MESSAGE, ordinal: 0 }));
  assert.deepEqual(started.frames, []);

  const delta = translator.translate(event('session.text.delta', { assistantMessageID: MESSAGE, ordinal: 0, delta: 'cloudcli-' }));
  assert.equal(delta.frames.length, 1);
  assert.equal(delta.frames[0].kind, 'stream_delta');
  assert.equal(delta.frames[0].content, 'cloudcli-');
  assert.equal(delta.frames[0].sessionId, SESSION);
  assert.equal(delta.frames[0].provider, 'opencode');
  assert.equal(delta.frames[0].timestamp, new Date(1792203579833).toISOString());

  const ended = translator.translate(event('session.text.ended', { assistantMessageID: MESSAGE, ordinal: 0, text: 'cloudcli-probe-123' }));
  assert.equal(ended.frames.length, 2);
  assert.equal(ended.frames[0].kind, 'text');
  assert.equal(ended.frames[0].role, 'assistant');
  assert.equal(ended.frames[0].content, 'cloudcli-probe-123');
  assert.equal(ended.frames[1].kind, 'stream_end');
  assert.equal(ended.terminal, undefined);
});

test('names the finished text row after the streamed segment id, so the client placeholder can be adopted', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);

  // Block 1 is a text part that follows a reasoning part; per-type ordinals
  // count text parts only, so this block streams and lands as ordinal 0.
  translator.translate(event('session.reasoning.delta', { assistantMessageID: MESSAGE, ordinal: 0, delta: 'thinking' }));
  const ended = translator.translate(event('session.text.ended', { assistantMessageID: MESSAGE, ordinal: 0, text: 'cloudcli-probe-123' }));

  const textRow = ended.frames[0];
  assert.equal(textRow.kind, 'text');
  assert.equal(textRow.id, `${MESSAGE}_text_0`);
  assert.ok(!isVolatileMessageId(textRow.id), 'transcript rows need deterministic ids');
});

test('an ended text segment with no body still closes the stream but emits no empty row', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  for (const text of ['', '   ']) {
    const ended = translator.translate(event('session.text.ended', { assistantMessageID: MESSAGE, ordinal: 0, text }));
    assert.equal(ended.frames.length, 1);
    assert.equal(ended.frames[0].kind, 'stream_end');
  }
});

test('zero-width-space bodies count as blank on every text frame', () => {
  // ses_eb34f87e3ffe (2026-10-18): DeepSeek ended every later segment with a
  // single U+200B. `.trim()` passes it, so each segment surfaced as a
  // transcript row whose only visible content was its copy control.
  const translator = new OpenCodeSessionEventTranslator(SESSION);

  const delta = translator.translate(event('session.text.delta', { assistantMessageID: MESSAGE, ordinal: 0, delta: '​' }));
  assert.deepEqual(delta.frames, []);

  const ended = translator.translate(event('session.text.ended', { assistantMessageID: MESSAGE, ordinal: 0, text: '​' }));
  assert.equal(ended.frames.length, 1);
  assert.equal(ended.frames[0].kind, 'stream_end');

  const reasoning = translator.translate(event('session.reasoning.ended', { assistantMessageID: MESSAGE, ordinal: 0, text: '​' }));
  assert.deepEqual(reasoning.frames, []);

  // Real content that merely carries invisible padding must still stream.
  const padded = translator.translate(event('session.text.delta', { assistantMessageID: MESSAGE, ordinal: 1, delta: '​ok' }));
  assert.equal(padded.frames.length, 1);
  assert.equal(padded.frames[0].content, '​ok');
});

test('emits reasoning deltas under one stable block id and does not repeat the block on ended', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);

  const first = translator.translate(event('session.reasoning.delta', { assistantMessageID: MESSAGE, ordinal: 0, delta: 'The user wants' }));
  const second = translator.translate(event('session.reasoning.delta', { assistantMessageID: MESSAGE, ordinal: 0, delta: ' a shell call.' }));
  const ended = translator.translate(event('session.reasoning.ended', { assistantMessageID: MESSAGE, ordinal: 0, text: 'The user wants a shell call.' }));

  assert.equal(first.frames[0].kind, 'thinking');
  assert.equal(first.frames[0].content, 'The user wants');
  assert.equal(second.frames[0].content, ' a shell call.');
  assert.equal(first.frames[0].id, second.frames[0].id, 'same block → same id so the timeline appends');
  assert.equal(first.frames[0].id, `${MESSAGE}_reasoning_0`);
  assert.ok(!isVolatileMessageId(first.frames[0].id), 'thinking rows need deterministic ids');
  assert.deepEqual(ended.frames, [], 'the full text on ended would duplicate the streamed deltas');
});

test('delivers a never-streamed reasoning block once from reasoning.ended', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  const ended = translator.translate(event('session.reasoning.ended', { assistantMessageID: MESSAGE, ordinal: 1, text: 'whole block' }));
  assert.equal(ended.frames.length, 1);
  assert.equal(ended.frames[0].kind, 'thinking');
  assert.equal(ended.frames[0].content, 'whole block');
  assert.equal(ended.frames[0].id, `${MESSAGE}_reasoning_1`);
});

test('tracks a tool call from input.started through called to success as upsertable frames', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);

  const started = translator.translate(event('session.tool.input.started', { assistantMessageID: MESSAGE, id: CALL, name: 'shell' }));
  assert.equal(started.frames.length, 1);
  assert.equal(started.frames[0].kind, 'tool_use');
  assert.equal(started.frames[0].toolName, 'shell');
  assert.equal(started.frames[0].toolId, CALL);
  assert.equal(started.frames[0].id, CALL);
  assert.deepEqual(started.frames[0].toolInput, {});

  const inputEnded = translator.translate(event('session.tool.input.ended', { assistantMessageID: MESSAGE, id: CALL, text: '{"command": "echo cloudcli-probe-123"}' }));
  assert.deepEqual(inputEnded.frames[0].toolInput, { command: 'echo cloudcli-probe-123' });
  assert.equal(inputEnded.frames[0].toolName, 'shell');

  const called = translator.translate(event('session.tool.called', { assistantMessageID: MESSAGE, id: CALL, input: { command: 'echo cloudcli-probe-123' }, executed: false }));
  assert.equal(called.frames[0].kind, 'tool_use');
  assert.equal(called.frames[0].id, CALL, 'every snapshot shares the call id so the timeline upserts in place');
  assert.deepEqual(translator.getToolCall(CALL), { name: 'shell', input: { command: 'echo cloudcli-probe-123' } });

  const progress = translator.translate(event('session.tool.progress', { assistantMessageID: MESSAGE, id: CALL, metadata: { shellID: 'sh_1' } }));
  assert.deepEqual(progress.frames, []);

  const success = translator.translate(event('session.tool.success', {
    assistantMessageID: MESSAGE,
    id: CALL,
    content: [{ type: 'text', text: 'cloudcli-probe-123\n' }],
    metadata: { status: 'completed', truncated: false, exit: 0 },
    executed: false,
  }));
  assert.equal(success.frames.length, 1);
  const result = success.frames[0];
  assert.equal(result.kind, 'tool_result');
  assert.equal(result.toolId, CALL);
  assert.equal(result.id, `${CALL}_result`);
  assert.equal(result.content, 'cloudcli-probe-123\n');
  assert.equal(result.isError, false);
  assert.deepEqual(result.toolResult, { content: 'cloudcli-probe-123\n', isError: false });
});

test('reports a rejected permission as an error tool_result carrying the engine message', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  translator.translate(event('session.tool.input.started', { assistantMessageID: MESSAGE, id: CALL, name: 'shell' }));
  const failed = translator.translate(event('session.tool.failed', {
    assistantMessageID: MESSAGE,
    id: CALL,
    error: { type: 'permission.rejected', message: 'The user declined this command.' },
    executed: false,
  }));
  assert.equal(failed.frames[0].kind, 'tool_result');
  assert.equal(failed.frames[0].isError, true);
  assert.equal(failed.frames[0].content, 'The user declined this command.');
  assert.equal(failed.frames[0].toolId, CALL);
});

test('ignores an unparseable tool input chunk instead of clobbering the card', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  translator.translate(event('session.tool.input.started', { assistantMessageID: MESSAGE, id: CALL, name: 'edit' }));
  const partial = translator.translate(event('session.tool.input.ended', { assistantMessageID: MESSAGE, id: CALL, text: '{"path": "a.ts", "con' }));
  assert.deepEqual(partial.frames, []);
});

test('step.ended carries no frames: the runtime reads authoritative totals from the session snapshot', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  const first = translator.translate(event('session.step.ended', {
    assistantMessageID: MESSAGE, finish: 'tool-calls', rawFinish: 'tool_calls', cost: 0.001,
    tokens: { input: 2563, output: 21, reasoning: 54, cache: { read: 18112, write: 0 } },
  }));
  const second = translator.translate(event('session.step.ended', {
    assistantMessageID: 'msg_2', finish: 'stop', cost: 0.002,
    tokens: { input: 100, output: 9, reasoning: 0, cache: { read: 0, write: 5 } },
  }));
  assert.deepEqual(first.frames, []);
  assert.deepEqual(second.frames, []);
});

test('maps execution terminals: succeeded, failed (message for the runtime), interrupted', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);

  const succeeded = translator.translate(event('session.execution.succeeded', {}, { location: undefined }));
  assert.deepEqual(succeeded, { frames: [], terminal: { outcome: 'succeeded' } });

  const failed = translator.translate(event('session.execution.failed', {
    error: { type: 'provider.quota', message: 'Upstream request failed: Insufficient account funds', status: 402 },
  }, { location: undefined }));
  assert.deepEqual(failed, {
    frames: [],
    terminal: { outcome: 'failed', error: 'Upstream request failed: Insufficient account funds' },
  });

  const interrupted = translator.translate(event('session.execution.interrupted', { reason: 'user' }, { location: undefined }));
  assert.deepEqual(interrupted, { frames: [], terminal: { outcome: 'interrupted', reason: 'user' } });
});

test('ignores lifecycle chatter and unknown event types', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  for (const type of [
    'session.created', 'session.model.selected', 'session.agent.selected', 'session.permissions',
    'session.inbox.enqueued', 'session.inbox.delivered', 'session.instructions.updated',
    'session.execution.started', 'session.step.started', 'session.step.streamed',
    'session.step.failed', 'session.usage.updated', 'session.text.started', 'session.reasoning.started',
    'session.something.new',
  ]) {
    assert.deepEqual(translator.translate(event(type, { anything: true })), { frames: [] }, type);
  }
});

// ---------------------------------------------------------------------------
// Subagent spawns: OpenCode's `subagent` tool is the client's `Agent` card.
// ---------------------------------------------------------------------------

const SUBAGENT_CALL = 'call_subagent_1';
const SUBAGENT_INPUT = { agent: 'general', description: 'Review the diff', prompt: 'Read the diff and report problems.' };

test('a subagent tool call reaches the page as an Agent row whose input the card can read', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);

  const announced = translator.translate(event('session.tool.input.started', {
    assistantMessageID: MESSAGE, id: SUBAGENT_CALL, name: 'subagent',
  }));
  assert.equal(announced.frames[0].toolName, 'Agent');

  const called = translator.translate(event('session.tool.called', {
    assistantMessageID: MESSAGE, id: SUBAGENT_CALL, input: SUBAGENT_INPUT,
  }));
  assert.equal(called.frames[0].kind, 'tool_use');
  assert.equal(called.frames[0].toolName, 'Agent');
  assert.equal(called.frames[0].toolId, SUBAGENT_CALL);
  assert.deepEqual(called.frames[0].toolInput, {
    subagent_type: 'general',
    description: 'Review the diff',
    prompt: 'Read the diff and report problems.',
  });
  // The permission bridge labels cards by the engine's own name.
  assert.equal(translator.getToolCall(SUBAGENT_CALL)?.name, 'subagent');
});

test('other OpenCode tools keep their engine names', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  const result = translator.translate(event('session.tool.called', {
    assistantMessageID: MESSAGE, id: CALL, name: 'shell', input: { command: 'ls' },
  }));
  assert.equal(result.frames[0].toolName, 'shell');
});

test('a finished subagent call settles its card as completed, naming the child session', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  translator.translate(event('session.tool.called', {
    assistantMessageID: MESSAGE, id: SUBAGENT_CALL, name: 'subagent', input: SUBAGENT_INPUT,
  }));

  const { frames } = translator.translate(event('session.tool.success', {
    assistantMessageID: MESSAGE,
    id: SUBAGENT_CALL,
    content: [{ type: 'text', text: 'Found two problems.' }],
    metadata: { sessionID: 'ses_child_1', status: 'completed', truncated: false },
  }));

  assert.deepEqual(frames.map((frame) => frame.kind), ['tool_result', 'task_status']);
  assert.equal(frames[1].toolUseId, SUBAGENT_CALL);
  assert.equal(frames[1].taskId, 'ses_child_1');
  assert.equal(frames[1].status, 'completed');
  assert.equal(frames[1].event, 'notification');
  assert.deepEqual(translator.settleOpenSubagents(), [], 'nothing is left to settle');
});

test('a failed subagent call settles its card as failed', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  translator.translate(event('session.tool.called', {
    assistantMessageID: MESSAGE, id: SUBAGENT_CALL, name: 'subagent', input: SUBAGENT_INPUT,
  }));

  const { frames } = translator.translate(event('session.tool.failed', {
    assistantMessageID: MESSAGE, id: SUBAGENT_CALL, error: { type: 'tool.error', message: 'child crashed' },
  }));

  assert.deepEqual(frames.map((frame) => frame.kind), ['tool_result', 'task_status']);
  assert.equal(frames[1].status, 'failed');
  assert.equal(frames[1].toolUseId, SUBAGENT_CALL);
});

test('a subagent call the run ended on is settled as stopped', () => {
  const translator = new OpenCodeSessionEventTranslator(SESSION);
  translator.translate(event('session.tool.called', {
    assistantMessageID: MESSAGE, id: SUBAGENT_CALL, name: 'subagent', input: SUBAGENT_INPUT,
  }));
  translator.translate(event('session.tool.called', {
    assistantMessageID: MESSAGE, id: CALL, name: 'shell', input: { command: 'ls' },
  }));

  const frames = translator.settleOpenSubagents();

  assert.equal(frames.length, 1, 'only the subagent call has a card to settle');
  assert.equal(frames[0].kind, 'task_status');
  assert.equal(frames[0].status, 'stopped');
  assert.equal(frames[0].toolUseId, SUBAGENT_CALL);
  assert.deepEqual(translator.settleOpenSubagents(), [], 'settling twice sends nothing new');
});

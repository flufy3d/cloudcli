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
  assert.equal(ended.frames.length, 1);
  assert.equal(ended.frames[0].kind, 'stream_end');
  assert.equal(ended.terminal, undefined);
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

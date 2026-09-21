/**
 * The diagnostics report has to answer the question the engine transcript
 * cannot: what did the client send, what came back, and what did it end up
 * holding. These pin the parts a report is useless without.
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import {
  buildDiagnosticsReport,
  readRecordedFrames,
  recordInboundFrame,
  recordOutboundFrame,
  resetRecordedFrames,
} from '@/shared/diagnostics/frameRecorder';

beforeEach(() => {
  resetRecordedFrames();
});

function row(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'row-1',
    sessionId: 'sess-a',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'codex',
    kind: 'text',
    ...overrides,
  } as NormalizedMessage;
}

test('both directions are recorded in arrival order with the fields identity turns on', () => {
  recordOutboundFrame({ type: 'chat.send', sessionId: 'sess-a', content: '继续' });
  recordInboundFrame({ kind: 'text', role: 'user', id: 'item-u1', sessionId: 'sess-a', content: '继续', seq: 7 });
  recordInboundFrame({ kind: 'protocol_error', sessionId: 'sess-a', error: 'A run is already in progress.' });

  const frames = readRecordedFrames();
  assert.deepEqual(frames.map((frame) => [frame.direction, frame.kind]), [
    ['out', 'chat.send'],
    ['in', 'text'],
    ['in', 'protocol_error'],
  ]);
  // A duplicated bubble is decided by id and role, so a report without them
  // cannot answer the only question it exists for.
  assert.equal(frames[1].id, 'item-u1');
  assert.equal(frames[1].role, 'user');
  assert.equal(frames[1].seq, 7);
  assert.equal(frames[2].summary, 'A run is already in progress.');
});

test('a long body is summarized rather than stored whole', () => {
  recordInboundFrame({ kind: 'text', role: 'assistant', sessionId: 'sess-a', content: 'x'.repeat(5000) });
  const [frame] = readRecordedFrames();
  assert.ok((frame.summary?.length ?? 0) < 200, 'the buffer must stay small enough to leave always on');
  assert.ok(frame.summary?.endsWith('…'));
});

test('the report pairs the frames with the rows the timeline is holding', () => {
  recordOutboundFrame({ type: 'chat.send', sessionId: 'sess-a', content: '继续' });
  recordInboundFrame({ kind: 'text', role: 'user', id: 'item-u1', sessionId: 'sess-a', content: '继续' });

  const report = buildDiagnosticsReport(
    'sess-a',
    [row({ id: 'local_1', role: 'user', content: '继续' }), row({ id: 'item-u1', role: 'user', content: '继续' })],
    {
      serverMessages: [row({ id: 'item-u1', role: 'user' })],
      realtimeMessages: [row({ id: 'local_1', role: 'user' })],
      retiredOptimisticUserAnchors: [],
      pendingPrompts: [['local_1', { afterRowId: null }]],
      runEnded: false,
    },
  );

  assert.equal(report.sessionId, 'sess-a');
  assert.equal(report.frames.length, 2);
  // Two rendered rows against one send is exactly the shape of the bug this
  // report exists to identify, and the report has to make it readable.
  assert.deepEqual(report.timeline?.rendered.map((r) => r.id), ['local_1', 'item-u1']);
  assert.deepEqual(report.timeline?.server, ['item-u1']);
  assert.deepEqual(report.timeline?.realtime, ['local_1']);
  assert.deepEqual(report.timeline?.retiredOptimisticUserAnchors, []);
});

test('a report taken with no session open still carries the frames', () => {
  recordInboundFrame({ kind: 'chat_subscribed', sessionId: 'sess-a' });
  const report = buildDiagnosticsReport(null, null, null);
  assert.equal(report.timeline, null);
  assert.equal(report.frames.length, 1);
});

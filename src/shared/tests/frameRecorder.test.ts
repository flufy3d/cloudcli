/**
 * The diagnostics report has to answer the question the engine transcript
 * cannot: what did the client send, what came back, and what did it end up
 * holding. These pin the parts a report is useless without.
 */

import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

import {
  persistRecordedFrames,
  readRecordedFrames,
  recordInboundFrame,
  recordOutboundFrame,
  resetRecordedFrames,
  restoreRecordedFrames,
} from '@/shared/diagnostics/frameRecorder';

beforeEach(() => {
  resetRecordedFrames();
});

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

test('frames survive a page reload, which is when a report is usually taken', () => {
  recordOutboundFrame({ type: 'chat.abort', sessionId: 'sess-a' });
  recordInboundFrame({ kind: 'complete', sessionId: 'sess-a' });
  persistRecordedFrames();

  // A reload keeps sessionStorage but empties the module's memory. Without
  // this the recorder is blank exactly when the user goes looking: the tab
  // that saw the incident has long since been refreshed.
  resetRecordedFrames({ keepStorage: true });
  assert.equal(readRecordedFrames().length, 0);
  restoreRecordedFrames();

  const frames = readRecordedFrames();
  assert.deepEqual(frames.map((frame) => frame.kind), ['chat.abort', 'complete']);
  assert.ok(frames.every((frame) => frame.load), 'each frame names the page load that recorded it');
});

test('a restored frame is marked as belonging to an earlier page load', async () => {
  recordOutboundFrame({ type: 'chat.send', sessionId: 'sess-a', content: 'first load' });
  persistRecordedFrames();
  const loadBeforeReload = readRecordedFrames()[0]?.load;

  // A real reload re-evaluates the module, which is what mints a new load id;
  // clearing the buffer in place cannot reproduce that.
  vi.resetModules();
  const reloaded = await import('@/shared/diagnostics/frameRecorder');
  reloaded.recordOutboundFrame({ type: 'chat.send', sessionId: 'sess-a', content: 'second load' });

  const [restored, fresh] = reloaded.readRecordedFrames();
  assert.equal(restored.load, loadBeforeReload);
  assert.notEqual(fresh.load, restored.load, 'a new page load must be distinguishable from the restored one');
});

test('clearing the recorder also clears what a reload would restore', () => {
  recordOutboundFrame({ type: 'chat.send', sessionId: 'sess-a', content: '继续' });
  persistRecordedFrames();

  resetRecordedFrames();
  restoreRecordedFrames();

  assert.equal(readRecordedFrames().length, 0);
});

test('unreadable stored frames are discarded rather than breaking the recorder', () => {
  window.sessionStorage.setItem('cloudcli-diagnostic-frames-v1', '{not json');
  restoreRecordedFrames();
  recordInboundFrame({ kind: 'text', sessionId: 'sess-a', content: 'still recording' });

  assert.deepEqual(readRecordedFrames().map((frame) => frame.kind), ['text']);
});

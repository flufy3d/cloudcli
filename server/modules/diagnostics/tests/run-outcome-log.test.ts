import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearRunOutcomes,
  readRunOutcomes,
  recordRunOutcome,
} from '@/modules/diagnostics/services/run-outcome-log.service.js';

function outcome(overrides: Partial<Parameters<typeof recordRunOutcome>[0]> = {}) {
  return {
    sessionId: 'session-1',
    provider: 'codex' as const,
    reason: 'engine_completed' as const,
    exitCode: 0,
    startedAt: Date.now() - 1_000,
    endedAt: Date.now(),
    eventCount: 12,
    lastSeq: 12,
    ...overrides,
  };
}

test('a recorded outcome is readable with its duration derived', () => {
  clearRunOutcomes();
  recordRunOutcome(outcome({ startedAt: 1_000, endedAt: 4_500 }));

  const [recorded] = readRunOutcomes();
  assert.equal(recorded?.sessionId, 'session-1');
  assert.equal(recorded?.reason, 'engine_completed');
  assert.equal(recorded?.durationMs, 3_500);
  assert.equal(typeof recorded?.endedAtIso, 'string');
});

test('outcomes are returned newest first so a report shows the last failure on top', () => {
  clearRunOutcomes();
  recordRunOutcome(outcome({ sessionId: 'older' }));
  recordRunOutcome(outcome({ sessionId: 'newer', reason: 'client_abort', exitCode: 0 }));

  const ids = readRunOutcomes().map((entry) => entry.sessionId);
  assert.deepEqual(ids, ['newer', 'older']);
});

test('the log is bounded, dropping the oldest entries first', () => {
  clearRunOutcomes();
  for (let index = 0; index < 120; index += 1) {
    recordRunOutcome(outcome({ sessionId: `session-${index}` }));
  }

  const recorded = readRunOutcomes();
  assert.equal(recorded.length, 100);
  assert.equal(recorded[0]?.sessionId, 'session-119');
  assert.equal(recorded.at(-1)?.sessionId, 'session-20');
});

test('a limit narrows the result without reordering it', () => {
  clearRunOutcomes();
  recordRunOutcome(outcome({ sessionId: 'a' }));
  recordRunOutcome(outcome({ sessionId: 'b' }));
  recordRunOutcome(outcome({ sessionId: 'c' }));

  assert.deepEqual(readRunOutcomes(2).map((entry) => entry.sessionId), ['c', 'b']);
});

test('an out-of-range limit falls back to the whole bounded log', () => {
  clearRunOutcomes();
  recordRunOutcome(outcome({ sessionId: 'only' }));

  assert.equal(readRunOutcomes(0).length, 1);
  assert.equal(readRunOutcomes(-5).length, 1);
  assert.equal(readRunOutcomes(9_999).length, 1);
});

test('no chat content reaches the log, only identifiers and counters', () => {
  clearRunOutcomes();
  recordRunOutcome(outcome());

  const [recorded] = readRunOutcomes();
  const serialized = JSON.stringify(recorded);
  assert.equal(serialized.includes('content'), false);
  assert.deepEqual(Object.keys(recorded ?? {}).sort(), [
    'durationMs',
    'endedAtIso',
    'eventCount',
    'exitCode',
    'lastSeq',
    'provider',
    'reason',
    'sessionId',
    'startedAtIso',
  ]);
});

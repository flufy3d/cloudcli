/**
 * The runtime contract gate.
 *
 * These cases stand in for the adapters the compiler cannot inspect: the two
 * `.js` provider runtimes, and anything that builds a payload from parsed
 * JSON. They assert the two outcomes the gate is allowed to have — reject an
 * envelope that is not a message, or pass a message with undeclared fields
 * removed — and never a third one where unknown data reaches the client.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { enforceNormalizedMessageContract } from '@/shared/normalized-message-contract.js';
import { generateMessageId } from '@/shared/utils.js';

test('a conforming message passes through untouched', () => {
  const payload = {
    id: 'msg-1',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    content: 'hello',
  };

  const result = enforceNormalizedMessageContract(payload);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.deepEqual(result.message, payload);
  assert.deepEqual(result.strippedKeys, []);
});

test('an undeclared field is stripped and named rather than forwarded', () => {
  const result = enforceNormalizedMessageContract({
    id: 'msg-2',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'claude',
    kind: 'tool_use',
    toolName: 'Read',
    inventedByAnAdapter: { nested: true },
  });

  assert.ok(result.ok);
  assert.deepEqual(result.strippedKeys, ['inventedByAnAdapter']);
  assert.equal('inventedByAnAdapter' in result.message, false);
  assert.equal(result.message.toolName, 'Read');
});

test('the message the gate returns is a copy, so the caller cannot mutate the original', () => {
  const payload = { provider: 'claude', kind: 'text', stray: 1 };
  const result = enforceNormalizedMessageContract(payload);

  assert.ok(result.ok);
  assert.equal('stray' in payload, true, 'the input is left alone');
  assert.equal('stray' in result.message, false);
});

test('a payload that is not a message at all is rejected', () => {
  for (const payload of [null, undefined, 'text', 42, []]) {
    const result = enforceNormalizedMessageContract(payload);
    assert.equal(result.ok, false, `${JSON.stringify(payload)} must be rejected`);
  }
});

test('a payload missing its envelope is rejected with the reason', () => {
  const noKind = enforceNormalizedMessageContract({ provider: 'codex', content: 'x' });
  assert.equal(noKind.ok, false);
  assert.ok(!noKind.ok && noKind.reason.includes('kind'));

  const noProvider = enforceNormalizedMessageContract({ kind: 'text', content: 'x' });
  assert.equal(noProvider.ok, false);
  assert.ok(!noProvider.ok && noProvider.reason.includes('provider'));
});

/**
 * A transcript row exists twice — as a live frame and as the persisted row a
 * later history read returns — so its id has to come from the engine's own
 * record. An id invented at emit time makes the same row arrive under a new
 * id every time, which is what forced the client to guess at which live row
 * and which persisted row were the same message.
 *
 * The compiler already refuses a generated id on a transcript row, but two
 * runtimes are `.js` and several history paths read their rows out of `any`,
 * so the gate reports it here as well.
 */
test('a generated id on a transcript row is reported as a contract violation', () => {
  const result = enforceNormalizedMessageContract({
    id: generateMessageId('text'),
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    content: 'hello',
  });

  assert.ok(result.ok, 'the row still reaches the client: a dropped reply is worse than a duplicate');
  assert.equal(result.contractViolations.length, 1);
  assert.match(result.contractViolations[0], /id/);
});

test('a generated id is fine on a frame that only exists while the run does', () => {
  for (const kind of ['stream_delta', 'complete', 'status', 'session_created']) {
    const result = enforceNormalizedMessageContract({
      id: generateMessageId(kind),
      sessionId: 'sess-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      provider: 'zcode',
      kind,
    });
    assert.ok(result.ok);
    assert.deepEqual(result.contractViolations, [], `${kind} may carry a generated id`);
  }
});

test('an engine-derived id on a transcript row passes clean', () => {
  const result = enforceNormalizedMessageContract({
    id: 'c841b977-a3e4-49ec-8d8c-f074975abe00',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: 'hi',
  });

  assert.ok(result.ok);
  assert.deepEqual(result.contractViolations, []);
});

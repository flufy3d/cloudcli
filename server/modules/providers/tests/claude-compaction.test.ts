import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-compaction-1';

/**
 * Both records that describe a compaction are `system` events, which normalized
 * to nothing before this: the boundary carries the numbers, the status says one
 * is running. Each becomes one ordinary assistant row, so a client that knows
 * nothing of `compact` still reads the sentence.
 */
test('a compacting status becomes a running row, and other statuses none', () => {
  const [running] = provider.normalizeMessage({
    type: 'system',
    subtype: 'status',
    status: 'compacting',
  }, SESSION_ID);

  assert.equal(running.content, 'Compacting conversation…');
  assert.equal(running.compact?.phase, 'running');

  assert.deepEqual(
    provider.normalizeMessage({ type: 'system', subtype: 'status', status: 'requesting' }, SESSION_ID),
    [],
  );
});

test('a failed compaction says so, with the reason when there is one', () => {
  const [failed] = provider.normalizeMessage({
    type: 'system',
    subtype: 'status',
    compact_result: 'failed',
    compact_error: 'context still too large',
  }, SESSION_ID);

  assert.equal(failed.content, 'Compaction failed: context still too large');
  assert.equal(failed.compact?.phase, 'failed');
  assert.equal(failed.compact?.error, 'context still too large');
});

test('the summary keeps its flag, so the client can fold it into the row', () => {
  const [row] = provider.normalizeMessage({
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
  }, SESSION_ID);

  assert.equal(row.role, 'assistant');
  assert.equal(row.isCompactSummary, true);
});

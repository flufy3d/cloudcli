import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompactionMessage } from '@/shared/utils.js';

const base = { id: 'row-1', sessionId: 'app-1', timestamp: '2026-10-23T00:00:00.000Z', provider: 'zcode' as const };

test('a finished compaction says how it was triggered, how far it shrank and how long it took', () => {
  const row = createCompactionMessage({
    ...base, phase: 'done', trigger: 'manual', preTokens: 333_557, postTokens: 18_730, durationMs: 140_470,
  });
  assert.equal(row.kind, 'text');
  assert.equal(row.role, 'assistant');
  assert.equal(row.id, 'row-1');
  assert.equal(row.content, 'Compacted · manual · 334k → 19k tokens · 2m 20s');
  assert.deepEqual(row.compact, { phase: 'done', trigger: 'manual', preTokens: 333_557, postTokens: 18_730, durationMs: 140_470 });
});

test('a finished compaction without numbers still reads as one', () => {
  assert.equal(createCompactionMessage({ ...base, phase: 'done' }).content, 'Compacted');
  assert.equal(createCompactionMessage({ ...base, phase: 'done', trigger: 'auto', preTokens: 1_200_000 }).content, 'Compacted · auto · 1.2M tokens');
});

test('a running and a failed compaction say so', () => {
  const running = createCompactionMessage({ ...base, phase: 'running', trigger: 'auto' });
  assert.equal(running.content, 'Compacting conversation…');
  assert.deepEqual(running.compact, { phase: 'running', trigger: 'auto' });

  const failed = createCompactionMessage({ ...base, phase: 'failed', error: 'quota' });
  assert.equal(failed.content, 'Compaction failed: quota');
  assert.deepEqual(failed.compact, { phase: 'failed', error: 'quota' });
  assert.equal(createCompactionMessage({ ...base, phase: 'failed' }).content, 'Compaction failed');
});

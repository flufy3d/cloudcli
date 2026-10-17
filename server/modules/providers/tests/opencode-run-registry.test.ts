import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenCodeApiError } from '@/modules/providers/list/opencode/opencode-api.client.js';
import { OpenCodeRunRegistry, toOpenCodeTokenBudget } from '@/modules/providers/list/opencode/opencode-run-registry.js';
import type { NormalizedMessage } from '@/shared/types.js';

const writerOf = () => {
  const frames: NormalizedMessage[] = [];
  return { frames, writer: { send: (data: unknown) => { frames.push(data as NormalizedMessage); } } };
};

test('dispatch routes events by provider session and settles on the first terminal only', async () => {
  const registry = new OpenCodeRunRegistry();
  const first = writerOf();
  const second = writerOf();
  const runA = registry.create('app-a', 'ses_a', first.writer);
  registry.create('app-b', 'ses_b', second.writer);

  registry.dispatch({ type: 'session.text.delta', data: { sessionID: 'ses_a', assistantMessageID: 'm', ordinal: 0, delta: 'hi' } });
  registry.dispatch({ type: 'session.text.delta', data: { sessionID: 'ses_unknown', assistantMessageID: 'm', ordinal: 0, delta: 'x' } });
  assert.equal(first.frames.length, 1);
  assert.equal(second.frames.length, 0);

  const outcome = { outcome: 'succeeded' as const };
  runA.settle(outcome);
  runA.settle({ outcome: 'failed', error: 'late' });
  registry.dispatch({ type: 'session.execution.failed', data: { sessionID: 'ses_a', error: { message: 'late event' } } });
  assert.deepEqual(await runA.settled, outcome, 'first settlement wins over later terminals');
});

test('reconcile settles a run whose session went idle after the prompt', async () => {
  const registry = new OpenCodeRunRegistry();
  const { writer } = writerOf();
  const run = registry.create('app-1', 'ses_1', writer);
  run.promptAccepted = true;
  run.startedAt = 1_000;

  await registry.reconcile({ getSession: async () => ({ outcome: 'succeeded', idleAt: 1_500, tokens: null }) });
  assert.deepEqual(await run.settled, { outcome: 'succeeded' });
});

test('reconcile maps outcome and ignores a session that went idle before the prompt', async () => {
  const registry = new OpenCodeRunRegistry();
  const { writer } = writerOf();
  const stale = registry.create('app-1', 'ses_stale', writer);
  stale.promptAccepted = true;
  stale.startedAt = 5_000;
  const fresh = writerOf();
  const interrupted = registry.create('app-2', 'ses_int', fresh.writer);
  interrupted.promptAccepted = true;
  interrupted.startedAt = 1_000;
  const failedRunWriter = writerOf();
  const failed = registry.create('app-3', 'ses_failed', failedRunWriter.writer);
  failed.promptAccepted = true;
  failed.startedAt = 1_000;

  const snapshots: Record<string, { outcome: string | null; idleAt: number | null; tokens: null }> = {
    ses_stale: { outcome: 'succeeded', idleAt: 2_000, tokens: null },
    ses_int: { outcome: 'interrupted', idleAt: 2_000, tokens: null },
    ses_failed: { outcome: 'failed', idleAt: 2_000, tokens: null },
  };
  await registry.reconcile({ getSession: async (id) => snapshots[id] });
  assert.equal(
    await Promise.race([stale.settled, Promise.resolve('still-open')]),
    'still-open',
    'an idle BEFORE the prompt is the previous run: keep waiting',
  );
  assert.deepEqual(await interrupted.settled, { outcome: 'interrupted', reason: 'reconciled after a stream drop' });
  assert.deepEqual(await failed.settled, { outcome: 'failed', error: 'The run failed while the event stream was disconnected.' });
});

test('reconcile: 404 loses the run, other errors keep it open, unaccepted prompts are skipped', async () => {
  const registry = new OpenCodeRunRegistry();
  const gone = writerOf();
  const lost = registry.create('app-1', 'ses_gone', gone.writer);
  lost.promptAccepted = true;
  const flaky = writerOf();
  const waiting = registry.create('app-2', 'ses_flaky', flaky.writer);
  waiting.promptAccepted = true;
  const early = writerOf();
  const notAccepted = registry.create('app-3', 'ses_early', early.writer);
  notAccepted.promptAccepted = false;

  let calls = 0;
  await registry.reconcile({
    getSession: async (id) => {
      calls += 1;
      if (id === 'ses_gone') {
        throw new OpenCodeApiError('GET', '/api/session/ses_gone', 404, { message: 'not found' });
      }
      throw new OpenCodeApiError('GET', '/api/session/x', 500, { message: 'boom' });
    },
  });
  assert.equal(calls, 2, 'both accepted runs are probed; the unaccepted one is skipped');
  assert.deepEqual(await lost.settled, { outcome: 'lost', error: 'The OpenCode session no longer exists.' });
  assert.equal(await Promise.race([waiting.settled, Promise.resolve('still-open')]), 'still-open', 'a 500 keeps the run open for the next reconnect');
  assert.equal(notAccepted.promptAccepted, false);
});

test('toOpenCodeTokenBudget sums cache reads into input and skips empty totals', () => {
  assert.equal(toOpenCodeTokenBudget({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.deepEqual(
    toOpenCodeTokenBudget({ input: 19154, output: 10, reasoning: 435, cacheRead: 2048, cacheWrite: 0 }),
    { used: 21647, inputTokens: 21202, outputTokens: 10, breakdown: { input: 21202, output: 10 } },
  );
});

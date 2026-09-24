import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  consumeCodexQuotaReset,
  fetchCodexQuota,
  resetCodexQuotaCache,
} from '../list/codex/codex-quota.provider.js';

function createAppServer(
  rateLimitResult: unknown,
  requests: Array<Record<string, unknown>>,
  consumeResult: unknown = { outcome: 'reset' },
): ChildProcess {
  const processEvents = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let inputBuffer = '';

  Object.assign(processEvents, {
    stdin,
    stdout,
    stderr,
    kill: () => true,
  });

  stdin.on('data', (chunk) => {
    inputBuffer += chunk.toString();
    let newlineIndex = inputBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = inputBuffer.slice(0, newlineIndex);
      inputBuffer = inputBuffer.slice(newlineIndex + 1);
      newlineIndex = inputBuffer.indexOf('\n');
      const request = JSON.parse(line) as Record<string, unknown>;
      requests.push(request);

      if (request.id === 'cloudcli-quota-initialize') {
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      } else if (request.id === 'cloudcli-quota-read') {
        stdout.write(`${JSON.stringify({ id: request.id, result: rateLimitResult })}\n`);
      } else if (request.id === 'cloudcli-quota-consume') {
        stdout.write(`${JSON.stringify({ id: request.id, result: consumeResult })}\n`);
      }
    }
  });

  return processEvents;
}

const rateLimitResponse = {
  rateLimits: {
    limitId: 'codex',
    limitName: 'Codex models',
    planType: 'plus',
    primary: {
      usedPercent: 25,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000,
    },
    secondary: {
      usedPercent: 60,
      windowDurationMins: 10_080,
      resetsAt: 1_800_604_800,
    },
  },
};

test('fetchCodexQuota performs the app-server handshake and normalizes both windows', async () => {
  resetCodexQuotaCache();
  const requests: Array<Record<string, unknown>> = [];

  const quota = await fetchCodexQuota(
    {},
    {
      startAppServer: () => createAppServer(rateLimitResponse, requests),
      now: () => 1_000,
    },
  );

  assert.deepEqual(requests.map((request) => request.method), [
    'initialize',
    'initialized',
    'account/rateLimits/read',
  ]);
  assert.ok(quota);
  assert.equal(quota.updatedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(quota.groups[0].name, 'Codex models');
  assert.equal(quota.groups[0].description, 'Codex plus plan');
  assert.deepEqual(
    quota.groups[0].buckets.map((bucket) => ({
      window: bucket.window,
      remainingFraction: bucket.remainingFraction,
      resetTime: bucket.resetTime,
    })),
    [
      {
        window: '5h',
        remainingFraction: 0.75,
        resetTime: '2027-01-15T08:00:00.000Z',
      },
      {
        window: 'weekly',
        remainingFraction: 0.4,
        resetTime: '2027-01-22T08:00:00.000Z',
      },
    ],
  );
});

test('fetchCodexQuota prefers the multi-limit response without duplicating its legacy mirror', async () => {
  resetCodexQuotaCache();
  const requests: Array<Record<string, unknown>> = [];
  const quota = await fetchCodexQuota(
    {},
    {
      startAppServer: () => createAppServer({
        ...rateLimitResponse,
        rateLimitsByLimitId: {
          codex: rateLimitResponse.rateLimits,
          review: {
            limitId: 'review',
            limitName: 'Code review',
            primary: { usedPercent: 10, windowDurationMins: 300 },
          },
        },
      }, requests),
      now: () => 2_000,
    },
  );

  assert.ok(quota);
  assert.deepEqual(quota.groups.map((group) => group.name), ['Codex models', 'Code review']);
});

test('fetchCodexQuota caches reads, supports forced refresh, and tolerates empty data', async () => {
  resetCodexQuotaCache();
  let processCount = 0;
  let response: unknown = rateLimitResponse;
  const startAppServer = () => {
    processCount += 1;
    return createAppServer(response, []);
  };
  const dependencies = { startAppServer, now: () => 10_000 };

  assert.ok(await fetchCodexQuota({}, dependencies));
  assert.ok(await fetchCodexQuota({}, dependencies));
  assert.equal(processCount, 1);

  response = { rateLimits: {} };
  assert.equal(await fetchCodexQuota({ forceRefresh: true }, dependencies), null);
  assert.equal(processCount, 2);
});

test('fetchCodexQuota propagates app-server startup failures for the API error state', async () => {
  resetCodexQuotaCache();
  await assert.rejects(
    () => fetchCodexQuota(
      {},
      {
        startAppServer: () => { throw new Error('Codex is unavailable'); },
        now: () => 10_000,
      },
    ),
    /Codex is unavailable/,
  );
});

const resetCreditPayload = {
  availableCount: 1,
  credits: [
    {
      id: 'RateLimitResetCredit_abc',
      resetType: 'codexRateLimits',
      status: 'available',
      grantedAt: 1_790_103_679,
      expiresAt: 1_792_695_679,
      title: 'Full reset (Weekly + 5 hr)',
      description: 'Thanks for using Codex! You have been granted one free rate limit reset.',
    },
    {
      id: 'RateLimitResetCredit_spent',
      resetType: 'codexRateLimits',
      status: 'redeemed',
      grantedAt: 1_790_103_679,
      expiresAt: 1_792_695_679,
      title: 'Full reset (Weekly + 5 hr)',
    },
  ],
};

test('fetchCodexQuota maps rate-limit reset credits into the quota payload', async () => {
  resetCodexQuotaCache();
  const quota = await fetchCodexQuota(
    {},
    {
      startAppServer: () => createAppServer({ ...rateLimitResponse, rateLimitResetCredits: resetCreditPayload }, []),
      now: () => 1_000,
    },
  );

  assert.ok(quota);
  assert.deepEqual(quota.resetCredits, {
    credits: [
      {
        id: 'RateLimitResetCredit_abc',
        resetType: 'all',
        title: 'Full reset (Weekly + 5 hr)',
        available: true,
        expireTime: new Date(1_792_695_679 * 1000).toISOString(),
      },
      {
        id: 'RateLimitResetCredit_spent',
        resetType: 'all',
        title: 'Full reset (Weekly + 5 hr)',
        available: false,
        expireTime: new Date(1_792_695_679 * 1000).toISOString(),
      },
    ],
  });
});

test('fetchCodexQuota omits resetCredits when the account holds no cards', async () => {
  resetCodexQuotaCache();
  const quota = await fetchCodexQuota(
    {},
    {
      startAppServer: () => createAppServer({ ...rateLimitResponse, rateLimitResetCredits: { availableCount: 0, credits: [] } }, []),
      now: () => 1_000,
    },
  );

  assert.ok(quota);
  assert.equal(quota.resetCredits, undefined);
});

test('consumeCodexQuotaReset reads fresh credits on the same connection and spends the matching card', async () => {
  resetCodexQuotaCache();
  const requests: Array<Record<string, unknown>> = [];
  const result = await consumeCodexQuotaReset(
    { resetType: '5h' },
    {
      startAppServer: () => createAppServer(
        { ...rateLimitResponse, rateLimitResetCredits: resetCreditPayload },
        requests,
        { outcome: 'reset' },
      ),
      now: () => 1_000,
    },
  );

  assert.deepEqual(result, { ok: true, code: 'reset', message: 'Codex rate limits were reset.' });
  assert.deepEqual(requests.map((request) => request.method), [
    'initialize',
    'initialized',
    'account/rateLimits/read',
    'account/rateLimitResetCredit/consume',
  ]);
  const consumeRequest = requests.find((request) => request.id === 'cloudcli-quota-consume');
  assert.ok(consumeRequest);
  const params = consumeRequest.params as Record<string, unknown>;
  assert.equal(params.creditId, 'RateLimitResetCredit_abc');
  assert.equal(typeof params.idempotencyKey, 'string');
  assert.ok((params.idempotencyKey as string).length > 0);
});

test('consumeCodexQuotaReset declines without spending when no available card covers the request', async () => {
  resetCodexQuotaCache();
  const requests: Array<Record<string, unknown>> = [];
  const result = await consumeCodexQuotaReset(
    { resetType: '5h' },
    {
      startAppServer: () => createAppServer(
        { ...rateLimitResponse, rateLimitResetCredits: { availableCount: 0, credits: [] } },
        requests,
      ),
      now: () => 1_000,
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /No available quota reset card/);
  assert.equal(
    requests.some((request) => request.method === 'account/rateLimitResetCredit/consume'),
    false,
  );
});

test('consumeCodexQuotaReset surfaces the provider outcome when the spend fails', async () => {
  resetCodexQuotaCache();
  const result = await consumeCodexQuotaReset(
    { resetType: 'all' },
    {
      startAppServer: () => createAppServer(
        { ...rateLimitResponse, rateLimitResetCredits: resetCreditPayload },
        [],
        { outcome: 'alreadyRedeemed' },
      ),
      now: () => 1_000,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'noCard');
  assert.match(result.message ?? '', /alreadyRedeemed/);
});

test('consumeCodexQuotaReset reports an unknown outcome when the session dies mid-spend', async () => {
  resetCodexQuotaCache();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  // A dedicated fake: the process dies the moment the consume request goes
  // out, so the reply never arrives — the closest a mock gets to the
  // connection dropping after the spend left home.
  const dyingAppServer = (() => {
    const processEvents = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let inputBuffer = '';
    Object.assign(processEvents, { stdin, stdout, stderr, kill: () => true });
    stdin.on('data', (chunk) => {
      inputBuffer += chunk.toString();
      let newlineIndex = inputBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = inputBuffer.slice(0, newlineIndex).trim();
        inputBuffer = inputBuffer.slice(newlineIndex + 1);
        newlineIndex = inputBuffer.indexOf('\n');
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.id === 'cloudcli-quota-initialize') {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        } else if (request.id === 'cloudcli-quota-read') {
          stdout.write(`${JSON.stringify({ id: request.id, result: { ...rateLimitResponse, rateLimitResetCredits: resetCreditPayload } })}\n`);
        } else if (request.id === 'cloudcli-quota-consume') {
          processEvents.emit('exit', 137);
        }
      }
    });
    return processEvents;
  })();

  const result = await consumeCodexQuotaReset(
    { resetType: 'all' },
    { startAppServer: () => dyingAppServer, now: () => 1_000 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'unknown');
});

test('consumeCodexQuotaReset invalidates the quota cache after a successful spend', async () => {
  resetCodexQuotaCache();
  let processCount = 0;
  const dependencies = {
    startAppServer: () => {
      processCount += 1;
      return createAppServer(
        { ...rateLimitResponse, rateLimitResetCredits: resetCreditPayload },
        [],
        { outcome: 'reset' },
      );
    },
    now: () => 1_000,
  };

  assert.ok(await fetchCodexQuota({}, dependencies));
  assert.ok(await fetchCodexQuota({}, dependencies));
  assert.equal(processCount, 1);

  const result = await consumeCodexQuotaReset({ resetType: 'all' }, dependencies);
  assert.deepEqual(result.ok, true);
  assert.equal(processCount, 2, 'the spend opens its own session');

  assert.ok(await fetchCodexQuota({}, dependencies));
  assert.equal(processCount, 3, 'the fetch right after the spend must re-read, not reuse the stale cache');
});

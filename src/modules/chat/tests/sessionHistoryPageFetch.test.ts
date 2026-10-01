/**
 * Tests for the default history-page transport's request timeout.
 *
 * `AbortSignal.timeout` requires Safari 16 / Chrome 103; calling it on older
 * WebKit (e.g. iPadOS 15.4) throws a TypeError before the request is even
 * started, which left the whole chat history blank on those devices. These
 * tests pin the fallback: history must load, and the emulated timeout must
 * still abort and clean up, with the native API deleted from the environment.
 */

import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import {
  requestSessionHistoryPage,
} from '@/modules/chat/utils/sessionTimelineStore';

const HISTORY_REQUEST_TIMEOUT_MS = 30_000;

type MutableAbortSignal = { timeout?: unknown };

function withoutNativeTimeoutSignal<T>(run: () => Promise<T>): Promise<T> {
  const nativeTimeout = (AbortSignal as MutableAbortSignal).timeout;
  delete (AbortSignal as MutableAbortSignal).timeout;
  return run().finally(() => {
    (AbortSignal as MutableAbortSignal).timeout = nativeTimeout;
    vi.unstubAllGlobals();
  });
}

function okJsonResponse(payload: unknown) {
  return {
    ok: true,
    headers: { get: () => null },
    json: async () => payload,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test('loads a history page when AbortSignal.timeout is missing (Safari < 16)', async () => {
  await withoutNativeTimeoutSignal(async () => {
    const fetchStub = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      void init;
      return okJsonResponse({
        success: true,
        data: {
          messages: [{ id: 'm1', kind: 'text', role: 'user', content: 'hello' }],
          total: 1,
          hasMore: false,
        },
      });
    });
    vi.stubGlobal('fetch', fetchStub);

    const page = await requestSessionHistoryPage('sess-a', { limit: 10, offset: 0 });

    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0]?.content, 'hello');
    assert.equal(page.total, 1);
    assert.equal(page.hasMore, false);
    assert.ok(fetchStub.mock.calls[0]?.[1]?.signal instanceof AbortSignal);
  });
});

test('emulated timeout aborts the request after the limit elapses', async () => {
  vi.useFakeTimers();
  await withoutNativeTimeoutSignal(async () => {
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    }));

    const pending = requestSessionHistoryPage('sess-a', {});

    await vi.advanceTimersByTimeAsync(HISTORY_REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, /AbortError/);
    assert.equal(observedSignal?.aborted, true);
  });
});

test('the fallback timer is cancelled once the page request settles', async () => {
  vi.useFakeTimers();
  await withoutNativeTimeoutSignal(async () => {
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      observedSignal = init.signal;
      return okJsonResponse({ success: true, data: { messages: [], total: 0, hasMore: false } });
    }));

    await requestSessionHistoryPage('sess-a', {});
    await vi.advanceTimersByTimeAsync(HISTORY_REQUEST_TIMEOUT_MS);

    assert.equal(observedSignal?.aborted, false);
  });
});

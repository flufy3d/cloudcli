import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * Pins the top "loading older messages" spinner state.
 *
 * The transcript renders that spinner from `isLoadingMoreMessages`, but its
 * setter was left uncalled by a scroll refactor, so the state sat at `false`
 * forever and scrolling back into history loaded data with no indicator.
 * The test drives the real trigger path: scroll to the top of the
 * virtualized transcript -> requestOlder -> loadOlderMessages.
 */

const project: Project = {
  projectId: 'project-1', name: 'project-1', fullPath: '/tmp/project-1', displayName: 'Project 1',
};
const session = { id: 'session-1' } as ProjectSession;

function row(n: number) {
  return {
    id: `m${n}`,
    sessionId: session.id,
    timestamp: `2026-01-01T00:00:0${n}.000Z`,
    provider: 'claude' as const,
    kind: 'text' as const,
    role: (n % 2 === 1 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `message ${n}`,
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let releaseOlderPage: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  releaseOlderPage = null;
  // The first page (offset 0) hydrates with hasMore so scrolling up may load
  // more; every later page parks on a promise the test releases after
  // asserting the in-flight spinner state.
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes('/messages')) return jsonResponse({});
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset') ?? 0);
    if (offset === 0) {
      // Hydrated tail; the older page must be strictly earlier in time or the
      // store reads the fetch as "history shifted while fetching" and retries.
      return jsonResponse({ messages: [row(3), row(4)], total: 4, hasMore: true });
    }
    return new Promise<Response>((resolve) => {
      releaseOlderPage = () => resolve(jsonResponse({ messages: [row(1), row(2)], total: 4, hasMore: false }));
    });
  }));
});

afterEach(() => vi.unstubAllGlobals());

/** Stand-in for virtua's Virtualizer: big scroll height so offset 0 is "at the top". */
function fakeVirtualizer() {
  return { scrollSize: 20000, viewportSize: 1000, scrollToIndex: () => undefined };
}

function mountSessionState() {
  return renderHook(() => {
    const sessionStore = useSessionStore();
    return useChatSessionState({
      isActive: true, selectedProject: project, selectedSession: session, ws: null,
      sendMessage: () => {}, resetStreamingState: () => {},
      statusCheckSentAtRef: { current: new Map() }, sessionStore, showThinking: false,
    });
  });
}

test('the older-history spinner state is on while the page is in flight and off after it lands', async () => {
  const mounted = mountSessionState();
  await waitFor(() => expect(mounted.result.current.isLoadingSessionMessages).toBe(false));
  expect(mounted.result.current.hasMoreMessages).toBe(true);

  act(() => {
    (mounted.result.current.virtualizerRef as { current: unknown }).current = fakeVirtualizer();
    mounted.result.current.handleScroll(0);
  });

  expect(mounted.result.current.isLoadingMoreMessages).toBe(true);

  // The page request is enqueued one microtask after the scroll, so wait for
  // it to actually go out before releasing it.
  await waitFor(() => expect(releaseOlderPage).not.toBeNull());
  await act(async () => {
    releaseOlderPage?.();
  });
  await waitFor(() => expect(mounted.result.current.isLoadingMoreMessages).toBe(false));

  expect(mounted.result.current.hasMoreMessages).toBe(false);
});

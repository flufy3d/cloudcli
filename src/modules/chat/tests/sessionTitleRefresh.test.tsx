import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * A title that arrives for the open session must not read as a change to the
 * transcript.
 *
 * The engine names a session on its own, and the name reaches the open
 * session as a new copy of the session — same id, new title. The refresh
 * effect that re-reads the transcript after an out-of-band change watches the
 * session's id, not the copy, so a title does not pull the transcript again.
 */

const project: Project = {
  projectId: 'project-1', name: 'project-1', displayName: 'Project 1', fullPath: '/tmp/project-1',
};
const sendMessage = vi.fn();
const resetStreamingState = vi.fn();
const statusCheckSentAtRef = { current: new Map<string, number>() };

let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      success: true, data: { messages: [], total: 0, hasMore: false },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => vi.unstubAllGlobals());

const mountSession = (session: ProjectSession) => renderHook(
  ({ currentSession }: { currentSession: ProjectSession }) => {
    const sessionStore = useSessionStore();
    const state = useChatSessionState({
      isActive: true, selectedProject: project, selectedSession: currentSession,
      ws: null, sendMessage, resetStreamingState, statusCheckSentAtRef,
      sessionStore, showThinking: false, processingSessions: undefined,
      externalMessageUpdate: 1,
    });
    return { ...state, sessionStore };
  },
  { initialProps: { currentSession: session } },
);

test('a new title for the open session does not re-read the transcript', async () => {
  const session = { id: 'session-1', summary: 'First message' } as ProjectSession;
  const { result, rerender } = mountSession(session);

  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  const callsAfterMount = fetchCalls;

  // The engine named the session: the open session is the same conversation
  // with a new title.
  act(() => {
    rerender({ currentSession: { ...session, summary: 'The name the engine chose' } as ProjectSession });
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fetchCalls, callsAfterMount, 'the transcript must not be read again for a title');
});

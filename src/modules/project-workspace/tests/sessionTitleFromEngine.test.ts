import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession, ServerEvent, SessionUpsertedEvent } from '@/shared/types';

/**
 * The title a session gets from the engine reaches the page as a name-only
 * update.
 *
 * The engine names a session on its own, in its own time. That name arrives
 * as a `session_upserted` delta marked `metadataOnly`, and the client has to
 * take the title from it without treating it as a change to the transcript:
 * no re-read of the messages, no attention mark on a background session, and
 * no re-ordering of the sidebar. A delta that carries new activity still
 * means what it always meant — and it carries the title too, because the
 * open session's own copy of the title is what the header and the document
 * title read.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const APP_SESSION_ID = 'app-1';
const OTHER_SESSION_ID = 'app-2';

const buildProject = (sessions: ProjectSession[]): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions,
  sessionMeta: { hasMore: false, total: sessions.length },
});

const respondWith = (projects: Project[]) => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => projects });
};

type ServerEventListener = (event: ServerEvent) => void;

const listeners = new Set<ServerEventListener>();

const emit = (event: ServerEvent) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const buildUpsert = (overrides: {
  sessionId?: string;
  summary: string;
  metadataOnly?: boolean;
  lastActivity?: string;
}): SessionUpsertedEvent => ({
  kind: 'session_upserted',
  sessionId: overrides.sessionId ?? APP_SESSION_ID,
  providerSessionId: null,
  provider: 'opencode',
  ...(overrides.metadataOnly ? { metadataOnly: true } : {}),
  session: {
    id: overrides.sessionId ?? APP_SESSION_ID,
    summary: overrides.summary,
    messageCount: 0,
    lastActivity: overrides.lastActivity ?? '2026-01-01T00:00:00.000Z',
  },
  project: {
    projectId: 'project-1',
    path: '/repo',
    fullPath: '/repo',
    displayName: 'Repo',
    isStarred: false,
  },
  timestamp: '2026-01-01T00:00:00.000Z',
});

const renderProjectsState = async (navigate: ReturnType<typeof vi.fn>) => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: navigate as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

const selectSession = (result: { current: { handleSessionSelect: (session: ProjectSession) => void } }, id: string) => {
  act(() => {
    result.current.handleSessionSelect({ id, summary: 'First message', __projectId: 'project-1' } as ProjectSession);
  });
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('a name-only update titles the sidebar row and the open session, and leaves the transcript alone', async () => {
  respondWith([buildProject([
    { id: APP_SESSION_ID, summary: 'First message' } as ProjectSession,
    { id: OTHER_SESSION_ID, summary: 'Another session' } as ProjectSession,
  ])]);
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate);
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });
  selectSession(result, APP_SESSION_ID);
  navigate.mockClear();

  const updatesBefore = result.current.externalMessageUpdate;

  await act(async () => {
    emit(buildUpsert({ summary: 'The name the engine chose', metadataOnly: true }));
  });

  assert.equal(result.current.selectedSession?.summary, 'The name the engine chose');
  assert.deepEqual(
    result.current.projects[0].sessions?.map((row) => row.summary),
    ['The name the engine chose', 'Another session'],
  );
  // The transcript did not change, so the chat is not told to re-read it.
  assert.equal(result.current.externalMessageUpdate, updatesBefore);
  // A name is not news: the session is not marked as needing attention.
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has(APP_SESSION_ID), false);
  assert.deepEqual(navigate.mock.calls, []);
});

test('a name-only update for a background session does not mark it as needing attention', async () => {
  respondWith([buildProject([
    { id: APP_SESSION_ID, summary: 'First message' } as ProjectSession,
    { id: OTHER_SESSION_ID, summary: 'Another session' } as ProjectSession,
  ])]);
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate);
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });
  selectSession(result, APP_SESSION_ID);

  await act(async () => {
    emit(buildUpsert({ sessionId: OTHER_SESSION_ID, summary: 'Named in the background', metadataOnly: true }));
  });

  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has(OTHER_SESSION_ID), false);
  assert.equal(
    result.current.projects[0].sessions?.find((row) => row.id === OTHER_SESSION_ID)?.summary,
    'Named in the background',
  );
});

test('a delta that carries activity still titles the open session', async () => {
  respondWith([buildProject([
    { id: APP_SESSION_ID, summary: 'First message' } as ProjectSession,
  ])]);
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate);
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });
  selectSession(result, APP_SESSION_ID);

  const updatesBefore = result.current.externalMessageUpdate;

  await act(async () => {
    emit(buildUpsert({ summary: 'The name the engine chose' }));
  });

  assert.equal(result.current.selectedSession?.summary, 'The name the engine chose');
  // The delta means the session changed, so the chat still re-reads it.
  assert.equal(result.current.externalMessageUpdate, updatesBefore + 1);
});

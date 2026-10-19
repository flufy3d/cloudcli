import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ActiveBackgroundTask, Project, ProjectSession, ServerEvent, SessionActivityMap } from '@/shared/types';

const project: Project = {
  projectId: 'project-1', name: 'project-1', displayName: 'Project 1', fullPath: '/tmp/project-1',
};
const session = { id: 'session-1' } as ProjectSession;
const sendMessage = vi.fn();
const resetStreamingState = vi.fn();
const statusCheckSentAtRef = { current: new Map<string, number>() };
const agent: ActiveBackgroundTask = {
  id: 'agent-1', toolName: 'Agent', command: 'Inspect code', startedAt: 12345,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    success: true, data: { messages: [], total: 0, hasMore: false },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => vi.unstubAllGlobals());

function taskStatus(tasks: ActiveBackgroundTask[], backgroundWorkPending?: boolean, canInterrupt?: boolean): ServerEvent {
  return {
    id: 'background-status', kind: 'status', sessionId: session.id,
    timestamp: '2026-10-05T00:00:00.000Z', provider: 'claude',
    text: 'background_tasks', backgroundTasks: tasks,
    backgroundWorkPending, canInterrupt,
  };
}

function mountSession(initialTasks: ActiveBackgroundTask[], processingSessions?: SessionActivityMap) {
  return renderHook(() => {
    const sessionStore = useSessionStore();
    if (!sessionStore.getSessionSlot(session.id)) {
      sessionStore.applyServerEvent(taskStatus(initialTasks));
    }
    const state = useChatSessionState({
      isActive: true, selectedProject: project, selectedSession: session,
      ws: null, sendMessage, resetStreamingState, statusCheckSentAtRef,
      sessionStore, showThinking: false, processingSessions,
    });
    return { ...state, sessionStore };
  });
}

test.each(['Agent', 'Workflow', 'Bash'])(
  'clears the %s task card and queue gate when the server reports no background tasks', async (toolName) => {
    const { result } = mountSession([{ ...agent, toolName }]);
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    expect(result.current.hasActiveBackgroundTasks).toBe(true);

    act(() => {
      result.current.sessionStore.applyServerEvent(taskStatus([]));
    });

    expect(result.current.sessionStore.getBackgroundTasks(session.id)).toEqual([]);
    expect(result.current.backgroundTasks).toEqual([]);
    expect(result.current.hasActiveBackgroundTasks).toBe(false);
  },
);

test('shows tasks started in the current session and retains the gate until the last task ends', async () => {
  const { result } = mountSession([]);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  expect(result.current.hasActiveBackgroundTasks).toBe(false);
  const command = { ...agent, id: 'command-1', toolName: 'Bash' };

  for (const tasks of [[agent, command], [command], []]) {
    act(() => {
      result.current.sessionStore.applyServerEvent(taskStatus(tasks));
    });
    expect(result.current.backgroundTasks).toEqual(tasks);
    expect(result.current.hasActiveBackgroundTasks).toBe(tasks.length > 0);
  }
});

test('clears completed cards but holds the queue gate until the background reply finishes', async () => {
  const { result } = mountSession([agent]);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  act(() => { result.current.sessionStore.applyServerEvent(taskStatus([], true)); });
  expect(result.current.backgroundTasks).toEqual([]);
  expect(result.current.hasActiveBackgroundTasks).toBe(true);
  expect(result.current.canAbortSession).toBe(true);
  act(() => { result.current.sessionStore.applyServerEvent(taskStatus([], false)); });
  expect(result.current.hasActiveBackgroundTasks).toBe(false);
});

test('the reply phase keeps one start time across renders', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    const { result, rerender } = mountSession([]);
    await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
    act(() => { result.current.sessionStore.applyServerEvent(taskStatus([], true)); });
    now.mockReturnValue(9_000);
    rerender();
    expect(result.current.sessionActivity?.startedAt).toBe(1_000);
    act(() => { result.current.sessionStore.applyServerEvent(taskStatus([agent], true)); });
    expect(result.current.sessionActivity?.startedAt).toBe(agent.startedAt);
  } finally {
    now.mockRestore();
  }
});

test('the background phase times from its tasks, not from when this tab marked it busy', async () => {
  const markedOnRefresh = new Map([[session.id, { statusText: null, canInterrupt: false, startedAt: 99_999, background: true }]]);
  const { result } = mountSession([agent], markedOnRefresh);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  expect(result.current.sessionActivity?.startedAt).toBe(agent.startedAt);
  expect(result.current.canAbortSession).toBe(true);
});

test('a response turn keeps its own activity while background work is pending', async () => {
  const responding = new Map([[session.id, { statusText: 'Compacting', canInterrupt: false, startedAt: 7 }]]);
  const { result } = mountSession([agent], responding);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  expect(result.current.hasActiveBackgroundTasks).toBe(true);
  expect(result.current.sessionActivity).toEqual(responding.get(session.id));
  expect(result.current.canAbortSession).toBe(false);
});

test('reconnect preserves the reply gate even when no task cards remain', async () => {
  const { result } = mountSession([]);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  act(() => {
    result.current.sessionStore.applyServerEvent({
      kind: 'chat_subscribed', sessionId: session.id, isProcessing: false,
      timestamp: '2026-10-07T00:00:00.000Z', lastSeq: 0, stale: false,
      pendingPermissions: [], backgroundTasks: [], backgroundWorkPending: true,
    });
  });
  expect(result.current.backgroundTasks).toEqual([]);
  expect(result.current.hasActiveBackgroundTasks).toBe(true);
});

test('reconciles task state from a reconnect acknowledgement without changing sessions', async () => {
  const { result } = mountSession([agent]);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));

  for (const tasks of [[], [agent]]) {
    act(() => {
      result.current.sessionStore.applyServerEvent({
        kind: 'chat_subscribed', sessionId: session.id, isProcessing: false,
        timestamp: '2026-10-05T00:00:00.000Z',
        lastSeq: 0, stale: false, pendingPermissions: [], backgroundTasks: tasks,
      });
    });
    expect(result.current.backgroundTasks).toEqual(tasks);
    expect(result.current.hasActiveBackgroundTasks).toBe(tasks.length > 0);
  }
});

test('background work the server says cannot be stopped offers no Stop, but still holds the queue', async () => {
  const { result } = mountSession([]);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));

  act(() => {
    result.current.sessionStore.applyServerEvent(taskStatus([agent], undefined, false));
  });
  expect(result.current.hasActiveBackgroundTasks).toBe(true);
  expect(result.current.isProcessing).toBe(true);
  expect(result.current.canAbortSession).toBe(false);

  // A frame that says nothing about it (Claude's) counts as stoppable again.
  act(() => {
    result.current.sessionStore.applyServerEvent(taskStatus([agent]));
  });
  expect(result.current.canAbortSession).toBe(true);
});

test('a reconnect acknowledgement carries whether the background work can be stopped', async () => {
  const { result } = mountSession([]);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  act(() => {
    result.current.sessionStore.applyServerEvent({
      kind: 'chat_subscribed', sessionId: session.id, isProcessing: false,
      timestamp: '2026-10-19T00:00:00.000Z', lastSeq: 0, stale: false,
      pendingPermissions: [], backgroundTasks: [agent], backgroundCanInterrupt: false,
    });
  });
  expect(result.current.hasActiveBackgroundTasks).toBe(true);
  expect(result.current.canAbortSession).toBe(false);
});

test('Claude background work leaves the input open; other engines\' work holds it back', async () => {
  const { result } = mountSession([]);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));

  act(() => {
    result.current.sessionStore.applyServerEvent({ ...taskStatus([agent]), backgroundWorkQueuesInput: false } as ServerEvent);
  });
  expect(result.current.hasActiveBackgroundTasks).toBe(true);
  expect(result.current.isInputBlocked).toBe(false);

  act(() => {
    result.current.sessionStore.applyServerEvent(taskStatus([agent]));
  });
  expect(result.current.isInputBlocked).toBe(true);
});

test('a reply in flight holds the input back even when the background work would not', async () => {
  const responding = new Map([[session.id, { statusText: 'Thinking', canInterrupt: true, startedAt: 7 }]]);
  const { result } = mountSession([], responding);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  act(() => {
    result.current.sessionStore.applyServerEvent({ ...taskStatus([agent]), backgroundWorkQueuesInput: false } as ServerEvent);
  });
  expect(result.current.isInputBlocked).toBe(true);
});

test('a reconnect acknowledgement carries whether the background work holds the input back', async () => {
  const { result } = mountSession([]);
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  act(() => {
    result.current.sessionStore.applyServerEvent({
      kind: 'chat_subscribed', sessionId: session.id, isProcessing: false,
      timestamp: '2026-10-19T00:00:00.000Z', lastSeq: 0, stale: false,
      pendingPermissions: [], backgroundTasks: [agent], backgroundWorkQueuesInput: false,
    });
  });
  expect(result.current.isInputBlocked).toBe(false);
});

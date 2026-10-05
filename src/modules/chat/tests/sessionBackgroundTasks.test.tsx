import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ActiveBackgroundTask, Project, ProjectSession, ServerEvent } from '@/shared/types';

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

function taskStatus(tasks: ActiveBackgroundTask[]): ServerEvent {
  return {
    id: 'background-status', kind: 'status', sessionId: session.id,
    timestamp: '2026-10-05T00:00:00.000Z', provider: 'claude',
    text: 'background_tasks', backgroundTasks: tasks,
  };
}

function mountSession(initialTasks: ActiveBackgroundTask[]) {
  return renderHook(() => {
    const sessionStore = useSessionStore();
    if (!sessionStore.getSessionSlot(session.id)) {
      sessionStore.applyServerEvent(taskStatus(initialTasks));
    }
    const state = useChatSessionState({
      isActive: true, selectedProject: project, selectedSession: session,
      ws: null, sendMessage, resetStreamingState, statusCheckSentAtRef,
      sessionStore, showThinking: false,
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

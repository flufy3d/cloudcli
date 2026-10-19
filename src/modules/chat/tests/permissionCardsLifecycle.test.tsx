import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import type { PendingPermissionRequest, ProjectSession, ServerEvent } from '@/shared/types';

const session = { id: 'session-1' } as ProjectSession;
let frameCounter = 0;

function mount() {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const mounted = renderHook(() => {
    const sessionStore = useSessionStore();
    const protection = useSessionProtection();
    const [pending, setPending] = useState<PendingPermissionRequest[]>([]);
    useChatRealtimeHandlers({
      sendMessage: () => {},
      isActive: true, subscribe, selectedSession: session, currentSessionId: session.id, provider: 'zcode',
      setTokenBudget: () => {}, pendingPermissionRequests: pending, setPendingPermissionRequests: setPending,
      statusCheckSentAtRef: { current: new Map() }, requestLatestMessages: async () => {}, sessionStore,
      onSessionIdle: protection.markSessionIdle, onSessionProcessing: protection.markSessionProcessing,
    });
    return { pending, protection };
  });
  const emit = (frame: Record<string, unknown>) => {
    frameCounter += 1;
    act(() => {
      for (const listener of listeners) {
        listener({ id: `f${frameCounter}`, sessionId: session.id, provider: 'zcode', timestamp: '2026-01-01T00:00:00.000Z', ...frame } as ServerEvent);
      }
    });
  };
  return { ...mounted, emit };
}

const permission = (requestId: string, context?: Record<string, unknown>) => ({
  kind: 'permission_request', requestId, toolName: 'Bash', input: { command: 'ls' }, context,
});

test('a permission request after the turn ended does not make the session look like a foreground reply', () => {
  const { result, emit } = mount();
  emit(permission('p1', { subagent: { toolUseId: 'call_agent', description: 'Review' } }));

  const activity = result.current.protection.processingSessions.get(session.id);
  expect(activity?.background).toBe(true);
  expect(result.current.protection.isSessionProcessing(session.id)).toBe(false);
  expect(result.current.pending.map((request) => request.requestId)).toEqual(['p1']);
});

test('a permission request during a foreground reply leaves that reply foreground', () => {
  const { result, emit } = mount();
  act(() => result.current.protection.markSessionProcessing(session.id));
  emit(permission('p1'));
  expect(result.current.protection.isSessionProcessing(session.id)).toBe(true);
  expect(result.current.protection.processingSessions.get(session.id)?.background).toBeUndefined();
});

test('a successful turn end keeps the cards of agents still running and clears the rest', () => {
  const { result, emit } = mount();
  act(() => result.current.protection.markSessionProcessing(session.id));
  emit(permission('mine'));
  emit(permission('theirs', { subagent: { toolUseId: 'call_agent', description: 'Review' } }));
  emit({ kind: 'complete', success: true, exitCode: 0 });

  expect(result.current.pending.map((request) => request.requestId)).toEqual(['theirs']);
});

test.each([{ success: false, exitCode: 1 }, { success: false, aborted: true, exitCode: 0 }])(
  'a failed or aborted turn end clears every card', (outcome) => {
    const { result, emit } = mount();
    act(() => result.current.protection.markSessionProcessing(session.id));
    emit(permission('theirs', { subagent: { toolUseId: 'call_agent', description: 'Review' } }));
    emit({ kind: 'complete', ...outcome });
    expect(result.current.pending).toEqual([]);
  },
);

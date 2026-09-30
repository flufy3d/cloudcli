import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

const authenticatedFetch = vi.fn();

vi.mock('@/shared/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  api: {
    getFiles: () => Promise.resolve({ ok: false }),
    slashCommands: {
      list: () => Promise.resolve({ ok: true, data: [] }),
    },
  },
}));

// The capability matrix the composer reads. Null (still loading) means no
// provider takes input over background work, which is what most cases need.
let providerCapabilities: Record<string, Record<string, unknown>> | null = null;

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilitiesMap: () => ({ capabilities: providerCapabilities, loaded: true }),
}));

beforeEach(() => {
  providerCapabilities = null;
});

const selectedProject = {
  projectId: 'project-1',
  name: 'project-1',
  path: '/tmp/project-1',
  fullPath: '/tmp/project-1',
  displayName: 'project-1',
} as unknown as Project;

const selectedSession = {
  id: 'session-1',
  summary: 'session-1',
} as unknown as ProjectSession;

const submitEvent = { preventDefault: () => undefined } as never;

test('queues message when hasActiveBackgroundTasks is true even if isLoading is false', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');

  const sent: Array<Record<string, unknown>> = [];

  let hasBgTasks = true;

  const { result, rerender } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'claude',
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'claude-3-7-sonnet',
      currentProviderEffort: 'default',
      isLoading: false,
      hasActiveBackgroundTasks: hasBgTasks,
      backgroundTasks: [
        { id: 't1', toolName: 'Bash', command: 'npm test', startedAt: Date.now() },
      ],
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'next command' } } as never);
  });

  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  // Message should be queued, not sent
  assert.equal(sent.length, 0, 'no message sent over websocket');
  assert.ok(result.current.queuedDraft, 'message entered queued draft');
  assert.equal(result.current.queuedDraft?.content, 'next command');

  // Now background task finishes
  hasBgTasks = false;
  rerender();

  // Once background task is no longer active, the queued draft should be flushed and sent
  await waitFor(() => {
    assert.equal(sent.length, 1, 'queued message was flushed and sent');
  });
  assert.equal(sent[0]?.content, 'next command');
});

test('allows forceSendQueuedDraft to send message immediately with forceInterrupt', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');

  const sent: Array<Record<string, unknown>> = [];

  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'claude',
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'claude-3-7-sonnet',
      currentProviderEffort: 'default',
      isLoading: false,
      hasActiveBackgroundTasks: true,
      backgroundTasks: [
        { id: 't1', toolName: 'Bash', command: 'npm test', startedAt: Date.now() },
      ],
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'force stop and run' } } as never);
  });

  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  assert.equal(sent.length, 0);
  assert.ok(result.current.queuedDraft);

  // User explicitly clicks force send
  await act(async () => {
    result.current.forceSendQueuedDraft();
  });

  await waitFor(() => {
    assert.equal(sent.length, 1, 'message sent after force send');
  });
  assert.equal(sent[0]?.content, 'force stop and run');
  assert.equal((sent[0]?.options as any)?.forceInterrupt, true);
});

test('appends subsequent inputs into existing queued draft without overwriting', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  const sent: Array<{ content?: string; options?: Record<string, unknown> }> = [];

  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default',
      currentProviderModel: 'claude-3-7-sonnet',
      currentProviderEffort: 'default',
      isLoading: false,
      hasActiveBackgroundTasks: true,
      canAbortSession: false,
      tokenBudget: null,
      setTokenBudget: () => undefined,
      sendMessage: (payload) => {
        sent.push(payload as never);
      },
      onSessionProcessing: () => undefined,
      onSessionEstablished: () => undefined,
      onFileOpen: () => undefined,
      onShowSettings: () => undefined,
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'first part' } } as never);
  });
  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  assert.equal(result.current.queuedDraft?.content, 'first part');

  act(() => {
    result.current.handleInputChange({ target: { value: 'second part' } } as never);
  });
  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  assert.equal(result.current.queuedDraft?.content, 'first part\n\nsecond part');
});

test('sends immediately over background work when the provider accepts input during it', async () => {
  providerCapabilities = { claude: { acceptsInputDuringBackgroundWork: true } };
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');

  const sent: Array<Record<string, unknown>> = [];

  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      // Its own session: queued drafts persist per session across cases.
      selectedSession: { id: 'session-accepts', summary: 'session-accepts' } as unknown as ProjectSession,
      currentSessionId: 'session-accepts',
      provider: 'claude',
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'claude-3-7-sonnet',
      currentProviderEffort: 'default',
      isLoading: false,
      hasActiveBackgroundTasks: true,
      backgroundTasks: [
        { id: 't1', toolName: 'Bash', command: 'npm test', startedAt: Date.now() },
      ],
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'while it runs' } } as never);
  });
  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  // The runtime feeds the turn into the live process, so nothing is held back.
  assert.equal(result.current.backgroundWorkQueuesInput, false);
  assert.equal(result.current.queuedDraft, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.content, 'while it runs');
});

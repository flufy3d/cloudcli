import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useSessionProtection } from '@/shared/hooks/useSessionProtection';

/**
 * A resident engine holds a submitted round until the native thread is idle.
 * The page has to be able to tell that apart from a round the engine is
 * working on, and the state has to survive the whole path: the poll's
 * snapshot, the activity map, and the frames the engine pushes afterwards.
 */

test('a polled session keeps the state that says it waits for the engine', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.syncProcessingSessions([
      { sessionId: 'session-1', queued: true, reporting: false },
    ]);
  });

  const activity = result.current.getSessionActivity('session-1');
  assert.equal(activity?.queued, true, 'the queued state must survive the poll');
  assert.equal(activity?.reporting, false);
});

test('a poll that does not mention the queue state keeps the last known one', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.syncProcessingSessions([{ sessionId: 'session-1', queued: true }]);
  });
  act(() => {
    result.current.syncProcessingSessions([{ sessionId: 'session-1', statusText: 'Thinking' }]);
  });

  assert.equal(result.current.getSessionActivity('session-1')?.queued, true);
});

test('a status frame that says nothing about the queue state does not clear it', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.syncProcessingSessions([{ sessionId: 'session-1', queued: true }]);
  });
  act(() => {
    result.current.markSessionProcessing('session-1', { statusText: 'Thinking' });
  });

  assert.equal(
    result.current.getSessionActivity('session-1')?.queued,
    true,
    'a status frame about something else must not wipe the queue state',
  );
});

test('the engine saying the round is running clears the wait', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.syncProcessingSessions([{ sessionId: 'session-1', queued: true }]);
  });
  act(() => {
    result.current.markSessionProcessing('session-1', { queued: false });
  });

  assert.equal(result.current.getSessionActivity('session-1')?.queued, false);
});

test('the report the engine runs is reported as a report', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.syncProcessingSessions([
      { sessionId: 'session-1', queued: true, reporting: true },
    ]);
  });

  const activity = result.current.getSessionActivity('session-1');
  assert.equal(activity?.queued, true);
  assert.equal(activity?.reporting, true);
});

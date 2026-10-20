import assert from 'node:assert/strict';

import { act, render, renderHook, screen } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import { ThemeProvider } from '@/shared/context/ThemeContext';

/**
 * A resident engine holds a submitted round until the native thread is idle,
 * so there is a stretch where the message is in the engine's queue and the
 * engine has not started the turn. The pill above the composer has to say
 * that, and it has to learn it through the real path: the server's poll and
 * the frames the engine pushes, not a hand-made activity.
 */

const renderWithTheme = (ui: React.ReactElement) =>
  render(<ThemeProvider>{ui}</ThemeProvider>);

test('a round waiting for the engine says so instead of showing a thinking label', () => {
  const { result } = renderHook(() => useSessionProtection());
  act(() => {
    result.current.syncProcessingSessions([{ sessionId: 'session-1', queued: true }]);
  });

  const activity = result.current.getSessionActivity('session-1');
  const { container } = renderWithTheme(
    <ActivityIndicator activity={activity ?? null} onAbort={() => {}} />,
  );

  assert.match(container.textContent ?? '', /waiting for the engine/i);
  assert.doesNotMatch(container.textContent ?? '', /Thinking/i);
  assert.ok(screen.getByRole('button', { name: /cancel the queued message/i }));
});

test('a round the engine is working on keeps the ordinary Stop button', () => {
  const { result } = renderHook(() => useSessionProtection());
  act(() => {
    result.current.syncProcessingSessions([{ sessionId: 'session-1', queued: false, statusText: 'Thinking' }]);
  });

  const activity = result.current.getSessionActivity('session-1');
  const { container } = renderWithTheme(
    <ActivityIndicator activity={activity ?? null} onAbort={() => {}} />,
  );

  assert.match(container.textContent ?? '', /Thinking/);
  assert.ok(screen.getByRole('button', { name: 'Stop' }));
});

test('a round waiting behind the engine own report says what it waits for', () => {
  const { result } = renderHook(() => useSessionProtection());
  act(() => {
    result.current.syncProcessingSessions([{ sessionId: 'session-1', queued: true, reporting: true }]);
  });

  const activity = result.current.getSessionActivity('session-1');
  const { container } = renderWithTheme(
    <ActivityIndicator activity={activity ?? null} onAbort={() => {}} />,
  );

  assert.match(container.textContent ?? '', /the engine is reporting/i);
});

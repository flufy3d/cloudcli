import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import type { SessionActivity } from '@/shared/types';
import { ThemeProvider } from '@/shared/context/ThemeContext';

/**
 * A resident engine holds a submitted round until the thread is idle. The pill
 * above the composer has to say that the conversation waits for the engine
 * instead of pretending it is being worked on, and the button has to say that
 * it cancels the waiting message rather than stopping a running turn.
 */

const renderWithTheme = (ui: React.ReactElement) =>
  render(<ThemeProvider>{ui}</ThemeProvider>);

const queuedActivity = (overrides: Partial<SessionActivity> = {}): SessionActivity => ({
  statusText: null,
  canInterrupt: true,
  startedAt: Date.now(),
  queued: true,
  ...overrides,
});

test('a round waiting for the engine says so instead of showing a thinking label', () => {
  const { container } = renderWithTheme(
    <ActivityIndicator activity={queuedActivity()} onAbort={() => {}} />,
  );

  assert.match(container.textContent ?? '', /waiting for the engine/i);
  assert.doesNotMatch(container.textContent ?? '', /Thinking/i);
});

test('the button of a waiting round says it cancels the queued message', () => {
  renderWithTheme(
    <ActivityIndicator activity={queuedActivity()} onAbort={() => {}} />,
  );

  assert.ok(screen.getByRole('button', { name: /cancel the queued message/i }));
  assert.equal(screen.queryByRole('button', { name: 'Stop' }), null);
});

test('a round the engine is working on keeps the ordinary Stop button', () => {
  const { container } = renderWithTheme(
    <ActivityIndicator activity={queuedActivity({ queued: false, statusText: 'Thinking' })} onAbort={() => {}} />,
  );

  assert.match(container.textContent ?? '', /Thinking/);
  assert.ok(screen.getByRole('button', { name: 'Stop' }));
});

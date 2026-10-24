import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import type { SessionActivity } from '@/shared/types';
import { ThemeProvider } from '@/shared/context/ThemeContext';

/**
 * Once background work ends, the engine starts a turn of its own to report on
 * it. Nothing is left in the background then, so the pill must say what is
 * happening instead of counting zero tasks.
 */

const renderWithTheme = (ui: React.ReactElement) =>
  render(<ThemeProvider>{ui}</ThemeProvider>);

const reportingActivity = (overrides: Partial<SessionActivity> = {}): SessionActivity => ({
  statusText: null,
  canInterrupt: true,
  startedAt: Date.now(),
  background: true,
  tasks: [],
  reporting: true,
  ...overrides,
});

test('the engine reporting on finished background work says so instead of counting zero tasks', () => {
  const { container } = renderWithTheme(
    <ActivityIndicator activity={reportingActivity()} onAbort={() => {}} />,
  );

  assert.match(container.textContent ?? '', /Reporting on background work/);
  assert.doesNotMatch(container.textContent ?? '', /0 tasks/);
});

test('a report that runs while other work is still in the background names that work', () => {
  const { container } = renderWithTheme(
    <ActivityIndicator
      activity={reportingActivity({
        tasks: [{ taskId: 'sh_1', toolUseId: 'call_sh', taskType: 'local_bash', description: 'npm test', startedAt: Date.now() }],
      })}
      onAbort={() => {}}
    />,
  );

  assert.match(container.textContent ?? '', /Reporting on background work/);
  assert.match(container.textContent ?? '', /Command npm test/);
});

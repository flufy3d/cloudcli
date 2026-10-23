import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';

import type * as UiPreferencesContext from '@/shared/context/UiPreferencesContext';
import { i18n } from '@/modules/i18n';
import type { ChatMessage } from '@/shared/types';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';

vi.mock('@/shared/context/UiPreferencesContext', async (importOriginal) => {
  const actual = await importOriginal<typeof UiPreferencesContext>();
  return {
    ...actual,
    useUiPreferences: () => ({ uiPreferences: { theme: 'light' }, setUiPreferences: () => undefined }),
  };
});

const compaction = (fields: Partial<ChatMessage>) => ({
  type: 'assistant',
  content: 'Compacted · manual · 153k → 26k tokens · 3m 24s',
  compact: { phase: 'done', trigger: 'manual' },
  timestamp: new Date('2026-10-24T00:24:00.000Z'),
  ...fields,
}) as unknown as ChatMessage;

const renderRow = (message: ChatMessage) => render(
  <I18nextProvider i18n={i18n}>
    <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="zcode" />
  </I18nextProvider>,
);

describe('compaction row', () => {
  it('is one line whose whole width toggles the folded summary', () => {
    renderRow(compaction({ compactSummary: 'Summary: banana.' }));

    const toggle = screen.getByRole('button', { name: /full summary|完整摘要/ });
    expect(toggle.textContent).toContain('Compacted · manual · 153k → 26k tokens · 3m 24s');
    expect(screen.queryByText('Summary: banana.')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByText('Summary: banana.')).toBeTruthy();
  });

  it('has nothing to open when the engine kept no summary', () => {
    renderRow(compaction({}));

    expect(screen.getByText('Compacted · manual · 153k → 26k tokens · 3m 24s')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

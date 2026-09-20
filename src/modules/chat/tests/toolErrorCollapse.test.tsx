import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import type { ChatMessage } from '@/shared/types';

const failedCommand = {
  type: 'assistant',
  content: '',
  isToolUse: true,
  toolName: 'Bash',
  toolInput: { command: 'false' },
  toolId: 'tool-failed',
  toolResult: { content: 'command failed', isError: true },
  timestamp: new Date('2026-09-20T01:00:00.000Z'),
} as unknown as ChatMessage;

describe('failed tool collapse defaults', () => {
  it('keeps a failed command row collapsed until the user opens it', async () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ToolRenderer
          toolName="Bash"
          toolInput={failedCommand.toolInput}
          toolResult={failedCommand.toolResult}
          toolId={failedCommand.toolId}
          mode="input"
        />
      </I18nextProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('[role="button"]')?.getAttribute('aria-expanded')).toBe('false');
    });
    expect(screen.queryByText('command failed')).toBeNull();
  });

  it('keeps a failed tool group collapsed until the user opens it', () => {
    const { container } = render(
      <ToolGroupContainer
        group={{
          _isGroup: true,
          toolName: 'Bash',
          messages: [
            failedCommand,
            { ...failedCommand, toolId: 'tool-second', toolResult: { content: 'ok', isError: false } },
          ],
          timestamp: failedCommand.timestamp,
        }}
        prevMessage={null}
        createDiff={() => []}
        getMessageKey={(message) => message.toolId || String(message.timestamp)}
        provider="claude"
      />,
    );

    expect(container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('command failed')).toBeNull();
  });
});

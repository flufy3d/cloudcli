import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import zhChat from '@/modules/i18n/locales/zh-CN/chat.json';
import Shell from '@/modules/shell/Shell';
import { useShellRuntime } from '@/modules/shell/hooks/useShellRuntime';
import type { Project } from '@/shared/types';

vi.mock('@/modules/shell/hooks/useShellRuntime', () => ({
  useShellRuntime: vi.fn(),
}));

// Mock child components that might touch canvas/DOM
vi.mock('@/modules/shell/TerminalShortcutsPanel', () => ({
  default: () => <div data-testid="terminal-shortcuts" />,
}));
vi.mock('@/modules/shell/ShellHeader', () => ({
  default: () => <div data-testid="shell-header" />,
}));

const mockedUseShellRuntime = vi.mocked(useShellRuntime);

const testProject: Project = {
  id: 'proj-1',
  projectId: 'proj-1',
  name: 'MirLite',
  displayName: 'MirLite',
  path: '/tmp/MirLite',
  fullPath: '/tmp/MirLite',
};

let testI18n: typeof i18n;

describe('Shell i18n provider interpolation', () => {
  beforeEach(async () => {
    testI18n = i18n.createInstance();
    await testI18n.use(initReactI18next).init({
      lng: 'zh-CN',
      fallbackLng: 'zh-CN',
      resources: {
        'zh-CN': {
          chat: zhChat,
        },
      },
      interpolation: {
        escapeValue: false,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('interpolates provider into connecting overlay without exposing raw {{provider}}', () => {
    mockedUseShellRuntime.mockReturnValue({
      terminalContainerRef: { current: null },
      terminalRef: { current: null },
      wsRef: { current: null },
      isConnected: false,
      isInitialized: true,
      isConnecting: true,
      connectToShell: vi.fn(),
      disconnectFromShell: vi.fn(),
    });

    render(
      <I18nextProvider i18n={testI18n}>
        <Shell selectedProject={testProject} selectedSession={null} />
      </I18nextProvider>,
    );

    // It should render "在 MirLite 中启动 Claude CLI" and must NOT contain "{{provider}}"
    const descriptionElement = screen.getByText(/MirLite/);
    expect(descriptionElement.textContent).not.toContain('{{provider}}');
    expect(descriptionElement.textContent).toContain('Claude');
  });

  it('interpolates provider into new session start overlay without exposing raw {{provider}}', () => {
    mockedUseShellRuntime.mockReturnValue({
      terminalContainerRef: { current: null },
      terminalRef: { current: null },
      wsRef: { current: null },
      isConnected: false,
      isInitialized: true,
      isConnecting: false,
      connectToShell: vi.fn(),
      disconnectFromShell: vi.fn(),
    });

    render(
      <I18nextProvider i18n={testI18n}>
        <Shell selectedProject={testProject} selectedSession={null} />
      </I18nextProvider>,
    );

    // It should render "启动新的 Claude 会话" and must NOT contain "{{provider}}"
    const descriptionElement = screen.getByText(/Claude/);
    expect(descriptionElement.textContent).not.toContain('{{provider}}');
    expect(descriptionElement.textContent).toContain('Claude');
  });
});

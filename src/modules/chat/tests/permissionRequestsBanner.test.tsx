import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { PendingPermissionRequest } from '@/shared/types';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

const makeRequest = (overrides: Partial<PendingPermissionRequest> = {}): PendingPermissionRequest => ({
  requestId: 'per_1',
  toolName: 'shell',
  input: { command: 'echo hi' },
  context: {},
  sessionId: 'app-1',
  receivedAt: new Date('2026-10-17T00:00:00Z'),
  ...overrides,
});

const renderBanner = (
  provider: 'claude' | 'opencode',
  requests: PendingPermissionRequest[] = [makeRequest()],
) => render(
  <PermissionRequestsBanner
    provider={provider}
    providerLabel={provider === 'claude' ? 'Claude' : 'OpenCode'}
    pendingPermissionRequests={requests}
    handlePermissionDecision={vi.fn()}
    handleGrantToolPermission={vi.fn()}
  />,
);

describe('PermissionRequestsBanner', () => {
  it('offers the persistent remember button only to Claude, the engine that honours it', () => {
    const claude = renderBanner('claude');
    expect(claude.getByText('Allow & remember')).toBeTruthy();
    claude.unmount();

    const opencode = renderBanner('opencode');
    expect(screen.queryByText('Allow & remember')).toBeNull();
    expect(screen.queryByText('Allow (saved)')).toBeNull();
    expect(opencode.getByText('Allow once')).toBeTruthy();
    expect(opencode.getByText('Deny')).toBeTruthy();
  });

  it('never reads Claude settings for a non-Claude request and allows once per request', () => {
    const decision = vi.fn();
    render(
      <PermissionRequestsBanner
        provider="opencode"
        providerLabel="OpenCode"
        pendingPermissionRequests={[makeRequest()]}
        handlePermissionDecision={decision}
        handleGrantToolPermission={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Allow once'));
    expect(decision).toHaveBeenCalledWith('per_1', { allow: true });
  });
});

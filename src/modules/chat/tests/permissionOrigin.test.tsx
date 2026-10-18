import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import type { PendingPermissionRequest } from '@/shared/types';

const request = (overrides: Partial<PendingPermissionRequest> = {}): PendingPermissionRequest => ({
  requestId: 'per_1', toolName: 'Bash', input: { command: 'npm test' }, context: {}, sessionId: 'app-1',
  receivedAt: new Date('2026-10-17T00:00:00Z'), ...overrides,
});

const mount = (requests: PendingPermissionRequest[]) => render(
  <PermissionRequestsBanner
    provider="opencode"
    providerLabel="OpenCode"
    pendingPermissionRequests={requests}
    handlePermissionDecision={vi.fn()}
    handleGrantToolPermission={vi.fn()}
  />,
);

describe('which subagent asked', () => {
  it('names the subagent on a card that came from one', () => {
    mount([request({ context: { subagent: { toolUseId: 'call_agent', description: 'Review the diff' } } })]);
    expect(screen.getByText(/From subagent: Review the diff/)).toBeTruthy();
  });

  it('says nothing extra on a card from the main thread', () => {
    mount([request()]);
    expect(screen.queryByText(/From subagent/)).toBeNull();
  });

  it('names the subagent on a question card too', () => {
    mount([request({
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] },
      context: { subagent: { toolUseId: 'call_agent', description: 'Review the diff' } },
    })]);
    expect(screen.getByText(/From subagent: Review the diff/)).toBeTruthy();
  });
});

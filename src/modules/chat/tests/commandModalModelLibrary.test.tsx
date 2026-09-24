import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';

import { i18n } from '@/modules/i18n';
import type {
  LLMProvider,
  ProviderAuthStatus,
  ProviderAuthStatusMap,
  ProviderModelActions,
  ProviderModelsDefinition,
} from '@/shared/types';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import ModelLibraryPanel from '@/modules/chat/modals/ModelLibraryPanel';

/**
 * Pins how the Model library panel resolves provider visibility: the /models
 * command modal must forward the install-status map so uninstalled provider
 * CLIs (e.g. Cursor, OpenCode) disappear from the tab row exactly as they do
 * in the empty-state picker, and providers whose install probe is still
 * loading must stay visible instead of flickering out.
 */

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authenticatedFetch: vi.fn(),
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilitiesMap: () => ({ capabilities: {} }),
}));

const ALL_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'zcode', 'antigravity'];

const status = (patch: Partial<ProviderAuthStatus>): ProviderAuthStatus => ({
  installed: true,
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loginCommand: null,
  loading: false,
  ...patch,
});

const statusMap = (
  patchByProvider: Partial<Record<LLMProvider, Partial<ProviderAuthStatus>>>,
): ProviderAuthStatusMap =>
  Object.fromEntries(
    ALL_PROVIDERS.map((provider) => [provider, status(patchByProvider[provider] ?? {})]),
  ) as ProviderAuthStatusMap;

const noopActions: ProviderModelActions = {
  create: vi.fn(() => Promise.resolve()),
  update: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
};

const catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = Object.fromEntries(
  ALL_PROVIDERS.map((provider) => [
    provider,
    { OPTIONS: [{ value: 'glm-a', label: 'glm-a' }], DEFAULT: 'glm-a' },
  ]),
);

function openManageModels(props: { providerAuthStatus?: ProviderAuthStatusMap }) {
  render(
    <I18nextProvider i18n={i18n}>
      <CommandResultModal
        payload={{
          kind: 'models',
          data: { current: { provider: 'claude', providerLabel: 'Claude', model: 'glm-a' } },
        }}
        onClose={vi.fn()}
        providerModelCatalog={catalog}
        providerModelActions={noopActions}
        activeProvider="claude"
        activeProviderModel="glm-a"
        currentSessionId={null}
        onSelectProviderModel={vi.fn(() => Promise.resolve({ scope: 'default' as const, model: 'glm-a' }))}
        {...props}
      />
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Manage models' }));
}

describe('CommandResultModal → ModelLibraryPanel provider visibility', () => {
  it('hides providers whose CLI is not installed', () => {
    openManageModels({
      providerAuthStatus: statusMap({ cursor: { installed: false }, opencode: { installed: false } }),
    });

    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.queryByText('Cursor')).toBeNull();
    expect(screen.queryByText('OpenCode')).toBeNull();
    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('still shows every provider tab when no auth status is provided', () => {
    openManageModels({});

    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('Cursor')).toBeTruthy();
    expect(screen.getByText('OpenCode')).toBeTruthy();
  });

  it('keeps tabs visible while install probes are still loading', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ModelLibraryPanel
          initialProvider="claude"
          providerModelCatalog={catalog}
          providerAuthStatus={statusMap(
            Object.fromEntries(
              ALL_PROVIDERS.map((provider) => [provider, { installed: false, loading: true }]),
            ) as Partial<Record<LLMProvider, Partial<ProviderAuthStatus>>>,
          )}
          actions={noopActions}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText('Claude')).toBeTruthy();
  });
});

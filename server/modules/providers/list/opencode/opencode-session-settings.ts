/**
 * OpenCode Session Settings
 *
 * Maps the UI permission mode onto the service-side controls and remembers
 * what has already been applied to each provider session, so a run only
 * issues the agent/permission/model switches that actually change
 * something (switching to `plan` enqueues a system reminder every time, so
 * repeating it per message would spam the transcript).
 *
 * The engine's default build agent allows every tool (verified live: a shell
 * call never asks on its own), so "ask" rules are what make permission cards
 * appear; read-only tools stay allowed in every mode.
 *
 * @module opencode-session-settings
 */

import type { OpenCodeApiClient, OpenCodeModelRef, OpenCodePermissionRule } from './opencode-api.client.js';

/** Actions a permission mode gates. */
const MUTATING_ACTIONS = ['shell', 'edit', 'write', 'patch'] as const;

/** What a UI permission mode means on the service. */
export type OpenCodeSessionSettings = {
  agent: 'build' | 'plan';
  permissions: OpenCodePermissionRule[];
};

/**
 * - plan              → the read-only `plan` agent (it denies edits itself)
 *                       plus ask rules for every mutating action.
 * - acceptEdits       → edits auto-allowed, shell still asks.
 * - bypassPermissions → no rules; the engine's default allows everything.
 * - default           → every mutating action asks.
 *
 * Consumers: opencode runtime; referenced by the capability catalog's
 * opencode comment; tests.
 */
export function resolveOpenCodeSessionSettings(permissionMode: unknown): OpenCodeSessionSettings {
  const askAll = MUTATING_ACTIONS.map((action) => ({ action, resource: '*', effect: 'ask' as const }));
  switch (permissionMode) {
    case 'plan':
      return { agent: 'plan', permissions: askAll };
    case 'acceptEdits':
      return { agent: 'build', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] };
    case 'bypassPermissions':
      return { agent: 'build', permissions: [] };
    default:
      return { agent: 'build', permissions: askAll };
  }
}

/**
 * Applies settings and model to provider sessions, skipping switches the
 * session already carries. `reset()` forgets everything after the service
 * restarts (a fresh server has no memory of earlier switches).
 *
 * Consumer: opencode runtime.
 */
export class OpenCodeSessionSettingsApplier {
  private readonly agents = new Map<string, string>();
  private readonly permissions = new Map<string, string>();
  private readonly models = new Map<string, string>();

  async apply(client: OpenCodeApiClient, providerSessionId: string, settings: OpenCodeSessionSettings): Promise<void> {
    if (this.agents.get(providerSessionId) !== settings.agent) {
      await client.switchAgent(providerSessionId, settings.agent);
      this.agents.set(providerSessionId, settings.agent);
    }
    const permissionKey = JSON.stringify(settings.permissions);
    if (this.permissions.get(providerSessionId) !== permissionKey) {
      await client.setPermissions(providerSessionId, settings.permissions);
      this.permissions.set(providerSessionId, permissionKey);
    }
  }

  async applyModel(client: OpenCodeApiClient, providerSessionId: string, model: OpenCodeModelRef): Promise<void> {
    const modelKey = JSON.stringify(model);
    if (this.models.get(providerSessionId) === modelKey) {
      return;
    }
    await client.switchModel(providerSessionId, model);
    this.models.set(providerSessionId, modelKey);
  }

  reset(): void {
    this.agents.clear();
    this.permissions.clear();
    this.models.clear();
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OpenCodeSessionSettingsApplier,
  resolveOpenCodeSessionSettings,
} from '@/modules/providers/list/opencode/opencode-session-settings.js';
import type { OpenCodeApiClient } from '@/modules/providers/list/opencode/opencode-api.client.js';

test('permission modes map onto agent plus ask rules', () => {
  const askAll = ['shell', 'edit', 'write', 'patch'].map((action) => ({ action, resource: '*', effect: 'ask' }));
  assert.deepEqual(resolveOpenCodeSessionSettings('plan'), { agent: 'plan', permissions: askAll });
  assert.deepEqual(resolveOpenCodeSessionSettings('acceptEdits'), { agent: 'build', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
  assert.deepEqual(resolveOpenCodeSessionSettings('bypassPermissions'), { agent: 'build', permissions: [] });
  assert.deepEqual(resolveOpenCodeSessionSettings('default'), { agent: 'build', permissions: askAll });
  assert.deepEqual(resolveOpenCodeSessionSettings(undefined), { agent: 'build', permissions: askAll });
  assert.deepEqual(resolveOpenCodeSessionSettings('nonsense'), { agent: 'build', permissions: askAll });
});

test('the applier skips switches the session already carries and applies changes again', async () => {
  const calls: Array<[string, unknown]> = [];
  const client = {
    switchAgent: async (sessionId: string, agent: string) => { calls.push(['agent', { sessionId, agent }]); },
    setPermissions: async (sessionId: string, permissions: unknown) => { calls.push(['permissions', { sessionId, permissions }]); },
    switchModel: async (sessionId: string, model: unknown) => { calls.push(['model', { sessionId, model }]); },
  } as unknown as OpenCodeApiClient;
  const applier = new OpenCodeSessionSettingsApplier();

  await applier.apply(client, 'ses_1', resolveOpenCodeSessionSettings('plan'));
  await applier.apply(client, 'ses_1', resolveOpenCodeSessionSettings('plan'));
  assert.equal(calls.length, 2, 'identical settings are not re-applied');

  await applier.apply(client, 'ses_2', resolveOpenCodeSessionSettings('plan'));
  assert.equal(calls.length, 4, 'a different session gets its own switches');

  await applier.apply(client, 'ses_1', resolveOpenCodeSessionSettings('acceptEdits'));
  await applier.applyModel(client, 'ses_1', { providerID: 'opencode-go', id: 'glm-5.3', variant: 'high' });
  await applier.applyModel(client, 'ses_1', { providerID: 'opencode-go', id: 'glm-5.3', variant: 'high' });
  await applier.applyModel(client, 'ses_1', { providerID: 'opencode-go', id: 'glm-5.3', variant: 'low' });

  const agents = calls.filter(([kind]) => kind === 'agent').map(([, payload]) => (payload as { agent: string }).agent);
  assert.deepEqual(agents, ['plan', 'plan', 'build'], 'ses_1 plan, ses_2 plan, ses_1 back to build');
  const models = calls.filter(([kind]) => kind === 'model').map(([, payload]) => payload);
  assert.equal(models.length, 2, 'an unchanged model is not re-switched');

  applier.reset();
  await applier.apply(client, 'ses_1', resolveOpenCodeSessionSettings('acceptEdits'));
  assert.equal(calls.filter(([kind]) => kind === 'agent').length, 4, 'after a reset the switch happens again');
});

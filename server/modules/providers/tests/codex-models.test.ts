import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import {
  CODEX_PREDEFINED_MODELS,
  CodexProviderModels,
} from '../list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

test('CODEX_PREDEFINED_MODELS sets gpt-6-sol as default model', () => {
  assert.equal(CODEX_PREDEFINED_MODELS.DEFAULT, 'gpt-6-sol');
});

test('CODEX_PREDEFINED_MODELS includes gpt-6-sol with expected reasoning efforts', () => {
  const gpt6Sol = CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === 'gpt-6-sol');
  assert.ok(gpt6Sol, 'gpt-6-sol must be included in CODEX_PREDEFINED_MODELS');
  assert.equal(gpt6Sol.label, 'GPT-6 Sol');
  assert.equal(gpt6Sol.effort?.default, 'medium');
  assert.deepEqual(
    gpt6Sol.effort?.values.map((v) => v.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
});

test('CODEX_PREDEFINED_MODELS includes gpt-6-luna with expected reasoning efforts', () => {
  const gpt6Luna = CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === 'gpt-6-luna');
  assert.ok(gpt6Luna, 'gpt-6-luna must be included in CODEX_PREDEFINED_MODELS');
  assert.equal(gpt6Luna.label, 'GPT-6 Luna');
  assert.equal(gpt6Luna.effort?.default, 'medium');
  assert.deepEqual(
    gpt6Luna.effort?.values.map((v) => v.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('CodexProviderModels getSupportedModels returns predefined catalog', async () => {
  const provider = new CodexProviderModels();
  const models = await provider.getSupportedModels();
  assert.equal(models.DEFAULT, 'gpt-6-sol');
  assert.ok(models.OPTIONS.some((o) => o.value === 'gpt-6-sol'));
  assert.ok(models.OPTIONS.some((o) => o.value === 'gpt-6-luna'));
});

test('bundles a Codex CLI new enough to know the GPT-6 Sol and Luna models', () => {
  // Codex only ships metadata for gpt-6-sol / gpt-6-luna from 0.155.0 on. An
  // older CLI still sends the request, but on fallback metadata: it warns
  // "Model metadata ... not found" and quietly drops `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 155, `bundled @openai/codex ${version} predates 0.155.0`);
});

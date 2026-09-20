import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveZCodeProviderConfigEnv } from '@/modules/providers/list/zcode/zcode-provider-config.js';

const BUILTIN_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE';
const PERSONAL_ENV = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE';

/**
 * Builds a temp tree shaped like a ZCode install: the engine bundle plus a
 * built-in config placed at `relativeConfig` (omitted when null).
 */
const withEngineLayout = async (
  relativeConfig: string | null,
  runTest: (enginePath: string, configPath: string | null) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zcode-provider-config-'));
  const engineDir = path.join(root, 'Contents', 'Resources', 'glm');
  await mkdir(engineDir, { recursive: true });
  const enginePath = path.join(engineDir, 'zcode.cjs');
  await writeFile(enginePath, '// engine', 'utf8');

  let configPath: string | null = null;
  if (relativeConfig) {
    configPath = path.resolve(engineDir, relativeConfig);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{}', 'utf8');
  }

  await runTest(enginePath, configPath);
};

test('finds the built-in config in the packaged Resources/config layout', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath, configPath) => {
    const env = resolveZCodeProviderConfigEnv(enginePath);

    assert.equal(env[BUILTIN_ENV], configPath);
  });
});

test('prefers the config co-located with the engine over the packaged sibling', async () => {
  await withEngineLayout(path.join('provider', 'zcode-builtin.json'), async (enginePath, configPath) => {
    const env = resolveZCodeProviderConfigEnv(enginePath);

    assert.equal(env[BUILTIN_ENV], configPath);
  });
});

test('points the personal config at the ZCode storage directory', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath) => {
    const previousStorage = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = path.join(os.tmpdir(), 'zcode-storage-fixture');
    try {
      const env = resolveZCodeProviderConfigEnv(enginePath);

      assert.equal(env[PERSONAL_ENV], path.join(process.env.ZCODE_STORAGE_DIR, 'v2', 'provider_config.json'));
    } finally {
      if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorage;
    }
  });
});

test('materializes the 0.16.9 provider registry from cli/config.json without changing the source config', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath) => {
    const previousStorage = process.env.ZCODE_STORAGE_DIR;
    const storageDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-provider-registry-'));
    process.env.ZCODE_STORAGE_DIR = storageDir;
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    const sourcePath = path.join(cliDir, 'config.json');
    const source = JSON.stringify({
      provider: {
        'bigmodel-coding-plan': {
          kind: 'anthropic',
          name: 'BigModel Coding Plan',
          options: { apiKey: 'fixture-key', baseURL: 'https://example.invalid/api/anthropic' },
          models: {
            'GLM-5.3-Flash': {
              reasoning: { enabled: true, levels: ['low', 'max'], defaultLevel: 'max' },
            },
          },
        },
        'builtin:bigmodel-coding-plan': {
          kind: 'anthropic',
          name: 'Reserved migration alias',
          options: { apiKey: 'fixture-key', baseURL: 'https://example.invalid/api/anthropic' },
          models: {
            'GLM-5.3-Flash': {
              reasoning: { enabled: true, levels: ['low', 'max'], defaultLevel: 'max' },
            },
          },
        },
      },
      model: 'builtin:bigmodel-coding-plan/GLM-5.3-Flash',
    });
    await writeFile(sourcePath, source, 'utf8');

    try {
      const env = resolveZCodeProviderConfigEnv(enginePath);
      const generatedPath = env[PERSONAL_ENV];
      assert.ok(generatedPath);
      const generated = JSON.parse(await readFile(generatedPath, 'utf8')) as any;
      assert.equal(generated.schemaVersion, 1);
      assert.equal(generated.config.providerConfigRules.providerRules.length, 1);
      assert.equal(generated.config.providerConfigRules.providerRules[0].providerId, 'bigmodel-coding-plan');
      assert.equal(generated.config.providerConfigRules.providerRules[0].config.access.apiKey, 'fixture-key');
      assert.deepEqual(generated.config.defaultModelSelection, {
        providerId: 'bigmodel-coding-plan',
        modelId: 'GLM-5.3-Flash',
        options: { reasoningLevel: 'max' },
      });
      assert.equal((await stat(generatedPath)).mode & 0o077, 0);
      assert.equal(await readFile(sourcePath, 'utf8'), source);
    } finally {
      if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorage;
    }
  });
});

test('ignores ambient ZCode_* variables inherited from a parent ZCode session', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath, configPath) => {
    const previousBuiltin = process.env[BUILTIN_ENV];
    const previousPersonal = process.env[PERSONAL_ENV];
    process.env[BUILTIN_ENV] = '/parent-session/builtin.json';
    process.env[PERSONAL_ENV] = '/parent-session/personal.json';
    try {
      const env = resolveZCodeProviderConfigEnv(enginePath);

      assert.equal(env[BUILTIN_ENV], configPath);
      assert.ok(env[PERSONAL_ENV]);
      assert.notEqual(env[PERSONAL_ENV], '/parent-session/personal.json');
    } finally {
      if (previousBuiltin === undefined) delete process.env[BUILTIN_ENV];
      else process.env[BUILTIN_ENV] = previousBuiltin;
      if (previousPersonal === undefined) delete process.env[PERSONAL_ENV];
      else process.env[PERSONAL_ENV] = previousPersonal;
    }
  });
});

test('returns no overrides when no built-in config exists, leaving the engine its own error', async () => {
  await withEngineLayout(null, async (enginePath) => {
    const env = resolveZCodeProviderConfigEnv(enginePath);

    assert.deepEqual(env, {});
  });
});

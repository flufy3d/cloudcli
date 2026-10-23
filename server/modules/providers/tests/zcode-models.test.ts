import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { encryptZCodeCredentialValue } from '@/modules/providers/list/zcode/zcode-credentials.js';
import {
  readZCodeStartPlanCatalog,
  resetZCodeStartPlanCatalogCache,
} from '@/modules/providers/list/zcode/zcode-start-plan-catalog.js';
import {
  ZCodeProviderModels,
  buildZCodeSendModelParams,
  resolveZCodeModelRef,
} from '@/modules/providers/list/zcode/zcode-models.provider.js';

/** Redirects ZCODE_STORAGE_DIR to a temp dir for fixture isolation. */
const withZCodeStorage = async (runTest: (storageDir: string) => Promise<void>): Promise<void> => {
  const previous = process.env.ZCODE_STORAGE_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-models-'));
  process.env.ZCODE_STORAGE_DIR = tempDir;

  try {
    await runTest(tempDir);
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_STORAGE_DIR;
    } else {
      process.env.ZCODE_STORAGE_DIR = previous;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
};

test('getSupportedModels falls back to the builtin catalog without a config', async () => {
  await withZCodeStorage(async () => {
    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    assert.equal(definition.DEFAULT, 'GLM-5.3');
    assert.equal(definition.OPTIONS[0].value, 'GLM-5.3');
    assert.deepEqual(
      definition.OPTIONS[0].effort?.values.map((value) => value.value),
      ['low', 'high', 'max']
    );
  });
});

test('getSupportedModels parses the cli config provider catalog', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'builtin:bigmodel-coding-plan': {
            kind: 'anthropic',
            models: {
              'GLM-5.3': {
                reasoning: { variants: ['max', 'low', 'high'] },
                limit: { context: 1000000, output: 128000 },
              },
            },
          },
        },
      }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    assert.equal(definition.OPTIONS.length, 1);
    assert.equal(definition.DEFAULT, 'GLM-5.3');
    assert.equal(definition.OPTIONS[0].description, 'ZCode model with 1000K context, 128K output');
    // Variants are normalized to reasoning intensity order: low -> high -> max
    assert.deepEqual(
      definition.OPTIONS[0].effort?.values.map((value) => value.value),
      ['low', 'high', 'max']
    );
  });
});

test('getSupportedModels ignores disabled providers and deduplicates model options', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'builtin:disabled-provider': {
            enabled: false,
            models: {
              'GLM-5.3': {
                reasoning: { variants: ['low'] },
              },
              'DISABLED-ONLY': {},
            },
          },
          'builtin:first-provider': {
            enabled: true,
            models: {
              'GLM-5.3': {
                reasoning: { variants: ['max', 'low'] },
              },
            },
          },
          'builtin:second-provider': {
            models: {
              'GLM-5.3': {
                reasoning: { variants: ['high'] },
              },
              'GLM-5.3-Flash': {},
            },
          },
        },
      }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // DISABLED-ONLY should not be present; GLM-5.3 must appear exactly once
    assert.deepEqual(
      definition.OPTIONS.map((opt) => opt.value),
      ['GLM-5.3', 'GLM-5.3-Flash']
    );
  });
});

test('readZCodeSessionModelInfoFromDb returns null without a database', async () => {
  await withZCodeStorage(async () => {
    const { readZCodeSessionModelInfoFromDb } = await import('@/modules/providers/list/zcode/zcode-models.provider.js');
    assert.equal(readZCodeSessionModelInfoFromDb('sess_any'), null);
  });
});

test('resolveZCodeModelRef parses full ref and bare model key', async () => {
  // Case 1: Full ref with slash
  const full = resolveZCodeModelRef('custom:zai/GLM-5.3');
  assert.deepEqual(full, {
    providerId: 'custom:zai',
    modelId: 'GLM-5.3',
  });

  // Case 2: With reasoning effort variant
  const fullWithVariant = resolveZCodeModelRef('custom:zai/GLM-5.3', 'high');
  assert.deepEqual(fullWithVariant, {
    providerId: 'custom:zai',
    modelId: 'GLM-5.3',
    options: { reasoningLevel: 'high' },
  });

  // Case 3: Bare model with config and variant
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'custom-provider': {
            enabled: true,
            models: {
              'GLM-5.3': {},
            },
          },
        },
      }),
      'utf8'
    );

    const resolved = resolveZCodeModelRef('GLM-5.3', 'max');
    assert.deepEqual(resolved, {
      providerId: 'custom-provider',
      modelId: 'GLM-5.3',
      options: { reasoningLevel: 'max' },
    });
  });
});

test('buildZCodeSendModelParams maps the selected model, reasoning level, and auth for 0.16.9', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': {
            kind: 'anthropic',
            options: { apiKey: 'fixture-key', baseURL: 'https://example.invalid/api/anthropic' },
            models: {
              'GLM-5.3-Flash': {
                reasoning: { enabled: true, levels: ['low', 'max'], defaultLevel: 'max' },
              },
            },
          },
        },
      }),
      'utf8'
    );

    assert.deepEqual(buildZCodeSendModelParams('GLM-5.3-Flash', 'low'), {
      modelSelection: {
        providerId: 'bigmodel-coding-plan',
        modelId: 'GLM-5.3-Flash',
        options: { reasoningLevel: 'low' },
      },
      modelExecution: {
        selectionScope: 'execution',
        requestAuth: { apiKey: 'fixture-key' },
      },
    });
    assert.deepEqual(
      buildZCodeSendModelParams('builtin:bigmodel-coding-plan/GLM-5.3-Flash'),
      {
        modelSelection: {
          providerId: 'bigmodel-coding-plan',
          modelId: 'GLM-5.3-Flash',
          options: { reasoningLevel: 'max' },
        },
        modelExecution: {
          selectionScope: 'execution',
          requestAuth: { apiKey: 'fixture-key' },
        },
      },
    );
  });
});

test('buildZCodeSendModelParams degrades to null instead of blocking the send when config is incomplete', async () => {
  await withZCodeStorage(async (storageDir) => {
    // No cli/config.json at all.
    assert.equal(buildZCodeSendModelParams('GLM-5.3'), null);

    // Provider present but without credentials or base URL.
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': { kind: 'anthropic', models: { 'GLM-5.3': {} } },
        },
      }),
      'utf8'
    );
    assert.equal(buildZCodeSendModelParams('GLM-5.3'), null);
  });
});

test('readZCodeSessionModelInfoFromDb returns model and variant from latest message', async () => {
  await withZCodeStorage(async (storageDir) => {
    const dbDir = path.join(storageDir, 'cli', 'db');
    await mkdir(dbDir, { recursive: true });

    const db = new Database(path.join(dbDir, 'db.sqlite'));
    try {
      db.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL,
          sequence INTEGER
        );
      `);
      const insert = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run('m1', 'sess_var', 1000, 1000, JSON.stringify({
        role: 'user',
        model: { modelID: 'GLM-5.3', variant: 'high' },
      }), 0);
    } finally {
      db.close();
    }

    const { readZCodeSessionModelInfoFromDb } = await import('@/modules/providers/list/zcode/zcode-models.provider.js');
    assert.deepEqual(readZCodeSessionModelInfoFromDb('sess_var'), {
      modelId: 'GLM-5.3',
      variant: 'high',
    });
  });
});

test('getSupportedModels includes BigModel (体验) start-plan model when zcodejwttoken is present', async () => {
  await withZCodeStorage(async (storageDir) => {
    resetZCodeStartPlanCatalogCache();
    const cliDir = path.join(storageDir, 'cli');
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(cliDir, { recursive: true });
    await mkdir(v2Dir, { recursive: true });

    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': {
            kind: 'anthropic',
            models: {
              'GLM-5.3': { reasoning: { variants: ['low', 'high', 'max'], defaultLevel: 'max' } },
              'GLM-5.3-Flash': { reasoning: { variants: ['low', 'high', 'max'], defaultLevel: 'max' } },
            },
          },
        },
      }),
      'utf8'
    );

    await writeFile(
      path.join(v2Dir, 'credentials.json'),
      JSON.stringify({ zcodejwttoken: 'mock-jwt-token' }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // Must strictly have exactly 3 models: 2 personal + 1 start-plan, no duplicates
    assert.equal(definition.OPTIONS.length, 3);
    assert.equal(definition.OPTIONS[0].value, 'GLM-5.3');
    assert.equal(definition.OPTIONS[0].group, 'BigModel (个人)');

    assert.equal(definition.OPTIONS[1].value, 'GLM-5.3-Flash');
    assert.equal(definition.OPTIONS[1].group, 'BigModel (个人)');

    const startPlan = definition.OPTIONS[2];
    assert.equal(startPlan.value, 'account:bigmodel-start-plan/GLM-5.3-Flash');
    assert.equal(startPlan.label, 'GLM-5.3-Flash');
    assert.equal(startPlan.group, 'BigModel (体验)');
    assert.equal(startPlan.effort?.default, 'max');
    assert.deepEqual(
      startPlan.effort?.values.map((v) => v.value),
      ['low', 'high', 'max']
    );
  });
});

test('getSupportedModels falls back to the builtin catalog when only the legacy v2 config exists', async () => {
  await withZCodeStorage(async (storageDir) => {
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(v2Dir, { recursive: true });
    await writeFile(
      path.join(v2Dir, 'config.json'),
      JSON.stringify({
        provider: {
          'builtin:bigmodel-coding-plan': {
            kind: 'anthropic',
            models: {
              'GLM-5.3': { reasoning: { variants: ['low', 'high', 'max'] } },
              'GLM-5.2': {},
            },
          },
        },
      }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // The v2 path is no longer consulted; the builtin catalog wins.
    assert.deepEqual(
      definition.OPTIONS.map((opt) => opt.value),
      ['GLM-5.3']
    );
  });
});

test('getSupportedModels lists billing-entitled start-plan models', async () => {
  await withZCodeStorage(async (storageDir) => {
    resetZCodeStartPlanCatalogCache();
    const cliDir = path.join(storageDir, 'cli');
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(cliDir, { recursive: true });
    await mkdir(v2Dir, { recursive: true });

    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': {
            kind: 'anthropic',
            models: {
              'GLM-5.3': { reasoning: { variants: ['low', 'high', 'max'], defaultLevel: 'max' } },
              'GLM-5.3-Flash': { reasoning: { variants: ['low', 'high', 'max'], defaultLevel: 'max' } },
            },
          },
        },
      }),
      'utf8'
    );

    await writeFile(
      path.join(v2Dir, 'credentials.json'),
      JSON.stringify({ zcodejwttoken: 'mock-jwt-token' }),
      'utf8'
    );

    // Pre-warm the shared catalog cache with an entitlement-driven read; the
    // models provider then consumes it through its default dependencies. The
    // JWT-shaped override is required because the fixture credential above is
    // a placeholder the real loader's shape guard would refuse.
    await readZCodeStartPlanCatalog({
      readJwtToken: () => 'header.payload.signature',
      fetchImpl: (async () => new Response(JSON.stringify({
        code: 0,
        data: {
          server_time: 1_800_000_000,
          plans: [{
            plan_id: 'zcode-v3-start-plan-1024',
            status: 'active',
            ends_at: 1_800_100_000,
            entitlements: [
              { show_name: 'GLM-5.3-Flash', capabilities: ['model:glm-5.3-flash'] },
              { show_name: 'GLM-5.3', capabilities: ['model:glm-5.3'] },
            ],
          }],
        },
      }), { status: 200 })) as typeof fetch,
    });

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // 2 personal + 2 entitled start-plan models, no duplicates
    assert.equal(definition.OPTIONS.length, 4);
    assert.equal(definition.OPTIONS[0].value, 'GLM-5.3');
    assert.equal(definition.OPTIONS[0].group, 'BigModel (个人)');
    assert.equal(definition.OPTIONS[1].value, 'GLM-5.3-Flash');
    assert.equal(definition.DEFAULT, 'GLM-5.3');

    const startPlanOptions = definition.OPTIONS.slice(2);
    assert.deepEqual(
      startPlanOptions.map((opt) => opt.value),
      [
        'account:bigmodel-start-plan/GLM-5.3-Flash',
        'account:bigmodel-start-plan/GLM-5.3',
      ]
    );
    assert.ok(startPlanOptions.every((opt) => opt.group === 'BigModel (体验)'));
    assert.equal(startPlanOptions[1].label, 'GLM-5.3');
    assert.equal(startPlanOptions[1].effort?.default, 'max');
    assert.deepEqual(
      startPlanOptions[1].effort?.values.map((v) => v.value),
      ['low', 'high', 'max']
    );
  });
});

test('buildZCodeSendModelParams resolves credentials for start-plan model from encrypted token', async () => {
  await withZCodeStorage(async (storageDir) => {
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(v2Dir, { recursive: true });
    // Simulate real ZCode encrypted token format (enc:v1:...)
    const encryptedToken = encryptZCodeCredentialValue('mock-jwt-token-abc');
    assert.match(encryptedToken, /^enc:v1:/);

    await writeFile(
      path.join(v2Dir, 'credentials.json'),
      JSON.stringify({ zcodejwttoken: encryptedToken }),
      'utf8'
    );

    const params = buildZCodeSendModelParams('account:bigmodel-start-plan/GLM-5.3-Flash', 'high');
    assert.ok(params);
    assert.deepEqual(params.modelSelection, {
      providerId: 'account:bigmodel-start-plan',
      modelId: 'GLM-5.3-Flash',
      options: { reasoningLevel: 'high' },
    });
    // Decrypted plain token must be passed, NEVER raw ciphertext
    assert.deepEqual(params.modelExecution, {
      selectionScope: 'execution',
      requestAuth: {
        apiKey: 'mock-jwt-token-abc',
      },
    });
  });
});

test('personal plan uses the native account provider and its own credential', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(cliDir, { recursive: true });
    await mkdir(v2Dir, { recursive: true });
    await writeFile(path.join(cliDir, 'config.json'), JSON.stringify({
      provider: {
        'bigmodel-coding-plan': {
          kind: 'anthropic',
          options: { apiKey: 'legacy-key', baseURL: 'https://example.invalid/api/anthropic' },
          models: { 'GLM-5.3-Flash': {} },
        },
      },
    }), 'utf8');
    await writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key':
        encryptZCodeCredentialValue('personal-plan-key'),
      zcodejwttoken: encryptZCodeCredentialValue('trial-jwt'),
    }), 'utf8');

    const catalog = await new ZCodeProviderModels().getSupportedModels();
    assert.equal(catalog.OPTIONS.find((option) => option.group === 'BigModel (个人)')?.value,
      'account:bigmodel-individual-coding-plan/GLM-5.3-Flash');
    assert.deepEqual(buildZCodeSendModelParams('account:bigmodel-individual-coding-plan/GLM-5.3-Flash', 'high'), {
      modelSelection: {
        providerId: 'account:bigmodel-individual-coding-plan',
        modelId: 'GLM-5.3-Flash',
        options: { reasoningLevel: 'high' },
      },
      modelExecution: { selectionScope: 'execution', requestAuth: { apiKey: 'personal-plan-key' } },
    });
    for (const legacyRef of [
      'bigmodel-coding-plan/GLM-5.3-Flash',
      'builtin:bigmodel-coding-plan/GLM-5.3-Flash',
    ]) {
      assert.equal(buildZCodeSendModelParams(legacyRef)?.modelSelection.providerId,
        'account:bigmodel-individual-coding-plan');
    }
  });
});

test('native individual plan remains selectable without a legacy provider config', async () => {
  await withZCodeStorage(async (storageDir) => {
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(v2Dir, { recursive: true });
    await writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'personal-key',
    }), 'utf8');
    const catalog = await new ZCodeProviderModels().getSupportedModels();
    assert.equal(catalog.DEFAULT, 'account:bigmodel-individual-coding-plan/GLM-5.3');
    assert.deepEqual(buildZCodeSendModelParams('GLM-5.3-Flash')?.modelSelection, {
      providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash',
      options: { reasoningLevel: 'max' },
    });
  });
});

test('account plan selection fails when its credential is missing', async () => {
  await withZCodeStorage(async () => {
    assert.throws(() => buildZCodeSendModelParams('account:bigmodel-individual-coding-plan/GLM-5.3-Flash'),
      /individual.*credential/i);
    assert.throws(() => buildZCodeSendModelParams('account:bigmodel-start-plan/GLM-5.3-Flash'),
      /start.*credential/i);
  });
});

test('a same-name custom model keeps its provider when an individual-plan key exists', async () => {
  await withZCodeStorage(async (storageDir) => {
    await mkdir(path.join(storageDir, 'cli'), { recursive: true });
    await mkdir(path.join(storageDir, 'v2'), { recursive: true });
    await writeFile(path.join(storageDir, 'cli', 'config.json'), JSON.stringify({ provider: {
      'custom-provider': {
        kind: 'anthropic', options: { apiKey: 'custom-key', baseURL: 'https://example.invalid/api' },
        models: { 'GLM-5.3-Flash': {} },
      },
      'bigmodel-coding-plan': {
        kind: 'anthropic', options: { apiKey: 'legacy-key', baseURL: 'https://example.invalid/api' },
        models: { 'GLM-5.3-Flash': {} },
      },
    } }), 'utf8');
    await writeFile(path.join(storageDir, 'v2', 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'personal-key',
    }), 'utf8');
    const catalog = await new ZCodeProviderModels().getSupportedModels();
    assert.equal(catalog.OPTIONS[0]?.group, 'custom-provider');
    assert.equal(buildZCodeSendModelParams(catalog.OPTIONS[0].value)?.modelSelection.providerId,
      'custom-provider');
  });
});

test('readZCodeSessionModelInfoFromDb preserves providerId when session ran on start-plan with providerID', async () => {
  await withZCodeStorage(async (storageDir) => {
    const dbDir = path.join(storageDir, 'cli', 'db');
    await mkdir(dbDir, { recursive: true });

    const db = new Database(path.join(dbDir, 'db.sqlite'));
    try {
      db.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL,
          sequence INTEGER
        );
      `);
      const insert = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
      );
      // Real engine writes providerID and modelID (uppercase ID)
      insert.run('m_start', 'sess_start_plan', 2000, 2000, JSON.stringify({
        role: 'user',
        model: {
          providerID: 'account:bigmodel-start-plan',
          modelID: 'GLM-5.3-Flash',
          variant: 'max',
        },
      }), 0);
    } finally {
      db.close();
    }

    const { readZCodeSessionModelInfoFromDb } = await import('@/modules/providers/list/zcode/zcode-models.provider.js');
    assert.deepEqual(readZCodeSessionModelInfoFromDb('sess_start_plan'), {
      modelId: 'account:bigmodel-start-plan/GLM-5.3-Flash',
      variant: 'max',
    });
  });
});

test('getSupportedModels enforces personal whitelist and keeps custom provider groups distinct', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });

    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': {
            kind: 'anthropic',
            models: {
              'GLM-5.3': {},
              'GLM-5.3-Flash': {},
              'GLM-4.7': {},
              'OBSOLETE-MODEL': {},
            },
          },
          'custom-provider-id': {
            name: 'Custom Provider',
            kind: 'openai',
            models: {
              'custom-model-x': {},
            },
          },
        },
      }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // Whitelist blocks GLM-4.7 and OBSOLETE-MODEL from personal provider
    const personalModels = definition.OPTIONS.filter((opt) => opt.group === 'BigModel (个人)');
    assert.deepEqual(
      personalModels.map((opt) => opt.value),
      ['GLM-5.3', 'GLM-5.3-Flash']
    );

    // Custom provider keeps its own group name, NEVER labeled BigModel (个人)
    const customModel = definition.OPTIONS.find((opt) => opt.value === 'custom-model-x');
    assert.ok(customModel);
    assert.equal(customModel.group, 'Custom Provider');
  });
});

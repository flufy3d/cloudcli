import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ZCODE_PLAN_BILLING_URL,
  readZCodeStartPlanCatalog,
  resetZCodeStartPlanCatalogCache,
  type ZCodeStartPlanCatalogDependencies,
} from '@/modules/providers/list/zcode/zcode-start-plan-catalog.js';

const FIXED_NOW_MS = 1_800_000_000_000;
const JWT = 'header.payload.signature';

/** Builds isolated dependencies; the default fetch fails loudly so a test can never hit the network. */
function makeDeps(overrides: Partial<ZCodeStartPlanCatalogDependencies> = {}): ZCodeStartPlanCatalogDependencies {
  return {
    readJwtToken: () => JWT,
    fetchImpl: async () => {
      throw new Error('unexpected network access in test');
    },
    now: () => FIXED_NOW_MS,
    ...overrides,
  };
}

/** Wraps a payload in a 200 response for fetch dependency overrides. */
function okJson(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
}

/** One active plan granting GLM-5.3-Flash and GLM-5.3, mirroring the live billing payload shape. */
function entitlementPayload(): unknown {
  return {
    code: 0,
    msg: '',
    data: {
      server_time: 1_800_000_000,
      plans: [{
        plan_id: 'zcode-v3-start-plan-1024',
        name: 'ZCode 1024 Dev Day',
        status: 'active',
        starts_at: 1_799_999_000,
        ends_at: 1_800_100_000,
        entitlements: [
          { show_name: 'GLM-5.3-Flash', meter: 'model_usage', unit_type: 'token', capabilities: ['model:glm-5.3-flash'], grant_units: 300_000_000, period: 'one_time', priority: 101 },
          { show_name: 'GLM-5.3', meter: 'model_usage', unit_type: 'token', capabilities: ['model:glm-5.3'], grant_units: 200_000_000, period: 'one_time', priority: 100 },
        ],
      }],
    },
  };
}

test('readZCodeStartPlanCatalog derives models from billing entitlements', async () => {
  resetZCodeStartPlanCatalogCache();
  let calledUrl = '';
  let calledAuthorization = '';
  const deps = makeDeps({
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledAuthorization = String(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify(entitlementPayload()), { status: 200 });
    }) as typeof fetch,
  });

  const models = await readZCodeStartPlanCatalog(deps);

  assert.equal(calledUrl, ZCODE_PLAN_BILLING_URL);
  assert.equal(calledAuthorization, `Bearer ${JWT}`);
  assert.deepEqual(models, [
    { modelId: 'GLM-5.3-Flash', label: 'GLM-5.3-Flash' },
    { modelId: 'GLM-5.3', label: 'GLM-5.3' },
  ]);
});

test('readZCodeStartPlanCatalog skips inactive and expired plans, dedupes, and ignores non-model grants', async () => {
  resetZCodeStartPlanCatalogCache();
  const deps = makeDeps({
    fetchImpl: okJson({
      code: 0,
      data: {
        server_time: 1_800_000_000,
        plans: [
          { status: 'expired', entitlements: [{ show_name: 'GLM-9', capabilities: ['model:glm-9'] }] },
          { status: 'active', ends_at: 1_799_999_999, entitlements: [{ show_name: 'GLM-9', capabilities: ['model:glm-9'] }] },
          {
            status: 'active',
            ends_at: 1_800_100_000,
            entitlements: [
              { show_name: 'GLM-5.3', capabilities: ['model:glm-5.3', 'tool:web_search'] },
              { capabilities: ['model:glm-5.3-turbo'] },
              { show_name: 'GLM-5.3', capabilities: ['model:GLM-5.3'] },
            ],
          },
        ],
      },
    }),
  });

  const models = await readZCodeStartPlanCatalog(deps);

  assert.deepEqual(models, [
    { modelId: 'GLM-5.3', label: 'GLM-5.3' },
    // Without show_name the canonical casing is unrecoverable; uppercase is the pinned best effort.
    { modelId: 'GLM-5.3-TURBO', label: 'GLM-5.3-TURBO' },
  ]);
});

test('readZCodeStartPlanCatalog returns null on transport, HTTP, and payload failures', async () => {
  resetZCodeStartPlanCatalogCache();
  assert.equal(
    await readZCodeStartPlanCatalog(makeDeps({ fetchImpl: async () => { throw new Error('boom'); } })),
    null,
  );

  resetZCodeStartPlanCatalogCache();
  assert.equal(
    await readZCodeStartPlanCatalog(makeDeps({ fetchImpl: okJson({ code: 401, msg: 'bad token' }) })),
    null,
  );

  resetZCodeStartPlanCatalogCache();
  assert.equal(
    await readZCodeStartPlanCatalog(makeDeps({ fetchImpl: async () => new Response('nope', { status: 500 }) })),
    null,
  );

  resetZCodeStartPlanCatalogCache();
  assert.equal(
    await readZCodeStartPlanCatalog(makeDeps({ fetchImpl: okJson({ code: 0, data: { plans: [] } }) })),
    null,
  );
});

test('readZCodeStartPlanCatalog skips the network for non-JWT credential placeholders', async () => {
  resetZCodeStartPlanCatalogCache();
  const deps = makeDeps({ readJwtToken: () => 'mock-jwt-token' });

  assert.equal(await readZCodeStartPlanCatalog(deps), null);
});

test('readZCodeStartPlanCatalog caches reads for the TTL regardless of outcome', async () => {
  resetZCodeStartPlanCatalogCache();
  let fetchCalls = 0;
  let nowMs = FIXED_NOW_MS;
  const deps = makeDeps({
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify(entitlementPayload()), { status: 200 });
    }) as typeof fetch,
    now: () => nowMs,
  });

  await readZCodeStartPlanCatalog(deps);
  await readZCodeStartPlanCatalog(deps);
  assert.equal(fetchCalls, 1);

  nowMs += 60_000;
  await readZCodeStartPlanCatalog(deps);
  assert.equal(fetchCalls, 2);
});

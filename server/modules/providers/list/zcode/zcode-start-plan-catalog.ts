/**
 * ZCode Start Plan Model Catalog
 *
 * Derives the BigModel start-plan (体验套餐) model list from the plan billing
 * API's per-model entitlements instead of a hardcoded entry, so the menu tracks
 * whatever the server currently grants (event plans such as "ZCode 1024 Dev
 * Day" rotate their model lineup independently of the app's bundled catalog).
 *
 * Consumers: zcode-models.provider.ts (start-plan model options) and
 * server/modules/providers/tests/zcode-start-plan-catalog.test.ts.
 *
 * @module zcode-start-plan-catalog
 */

import { createProviderQuotaCache, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { readDecryptedZCodeJwtToken } from './zcode-credentials.js';

/**
 * Billing endpoint of the ZCode start-plan proxy. Each active plan lists its
 * allowances as entitlements whose `capabilities` carry `model:<id>` entries.
 */
export const ZCODE_PLAN_BILLING_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/current';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30_000;

export type ZCodeStartPlanCatalogDependencies = {
  fetchImpl: typeof globalThis.fetch;
  readJwtToken: typeof readDecryptedZCodeJwtToken;
  now: () => number;
};

const DEFAULT_DEPENDENCIES: ZCodeStartPlanCatalogDependencies = {
  fetchImpl: globalThis.fetch,
  readJwtToken: readDecryptedZCodeJwtToken,
  now: () => Date.now(),
};

/** One entitled start-plan model: `modelId` is the engine-facing id, `label` the display text. */
export type ZCodeStartPlanModel = {
  modelId: string;
  label: string;
};

const catalogCache = createProviderQuotaCache<ZCodeStartPlanModel[]>(CACHE_TTL_MS);

/**
 * Resets the in-memory catalog cache. Consumers:
 * server/modules/providers/tests/zcode-start-plan-catalog.test.ts and
 * zcode-models.test.ts (isolation between fixture cases).
 */
export function resetZCodeStartPlanCatalogCache(): void {
  catalogCache.reset();
}

/**
 * Reads the start-plan models the account's active plans entitle, or null when
 * nothing usable can be determined (no credential, non-JWT placeholder,
 * transport/payload failure, no entitled models) so callers can fall back.
 * Results — including failures — are cached for CACHE_TTL_MS.
 */
export async function readZCodeStartPlanCatalog(
  dependencyOverrides: Partial<ZCodeStartPlanCatalogDependencies> = {},
): Promise<ZCodeStartPlanModel[] | null> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const jwtToken = deps.readJwtToken();
  if (!jwtToken) {
    return null;
  }
  return catalogCache.get({ forceRefresh: false }, async () => {
    try {
      // Credential placeholders without JWT shape (test fixtures, partial
      // writes) can never pass the billing endpoint's bearer check; skip the
      // network instead of failing slowly.
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwtToken)) {
        return null;
      }
      const response = await deps.fetchImpl(ZCODE_PLAN_BILLING_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${jwtToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        return null;
      }
      return extractEntitledModels(await response.json());
    } catch {
      return null;
    }
  }, deps.now);
}

/**
 * Extracts entitled start-plan models from the billing payload: every active,
 * unexpired plan's `capabilities` entry shaped `model:<id>` becomes one model.
 * `show_name` supplies the canonical engine-facing casing (e.g. `GLM-5.3-Flash`);
 * without it the capability suffix is uppercased as a best effort. Duplicate
 * grants across plans dedupe case-insensitively, keeping payload order. Returns
 * null when nothing usable remains.
 */
function extractEntitledModels(payload: unknown): ZCodeStartPlanModel[] | null {
  const envelope = readObjectRecord(payload);
  if (!envelope) {
    return null;
  }
  if (envelope.code !== undefined && envelope.code !== 0) {
    return null;
  }
  const data = readObjectRecord(envelope.data);
  if (!data) {
    return null;
  }
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const serverTimeSec = typeof data.server_time === 'number' ? data.server_time : null;

  const modelsByKey = new Map<string, ZCodeStartPlanModel>();
  for (const planRaw of plans) {
    const plan = readObjectRecord(planRaw);
    if (!plan) continue;
    const status = readOptionalString(plan.status);
    if (status && status !== 'active') continue;
    const endsAtSec = typeof plan.ends_at === 'number' ? plan.ends_at : null;
    if (endsAtSec !== null && serverTimeSec !== null && endsAtSec <= serverTimeSec) continue;

    const entitlements = Array.isArray(plan.entitlements) ? plan.entitlements : [];
    for (const entitlementRaw of entitlements) {
      const entitlement = readObjectRecord(entitlementRaw);
      if (!entitlement) continue;
      const capabilities = Array.isArray(entitlement.capabilities) ? entitlement.capabilities : [];
      const showName = readOptionalString(entitlement.show_name)?.trim() || '';
      const canonicalId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(showName) ? showName : '';

      for (const capability of capabilities) {
        if (typeof capability !== 'string' || !capability.startsWith('model:')) continue;
        const suffix = capability.slice('model:'.length).trim();
        if (!suffix) continue;
        const key = suffix.toLowerCase();
        if (modelsByKey.has(key)) continue;
        const modelId = canonicalId || suffix.toUpperCase();
        modelsByKey.set(key, { modelId, label: showName || modelId });
      }
    }
  }
  return modelsByKey.size > 0 ? [...modelsByKey.values()] : null;
}

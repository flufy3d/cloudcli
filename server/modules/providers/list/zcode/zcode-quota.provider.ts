/**
 * ZCode Quota and Rate Limit Provider
 *
 * Fetches account-level quota status (5-hour rolling token limits and cycle limits)
 * from BigModel / Z.AI monitoring endpoints using the decrypted OAuth token.
 *
 * Consumers:
 * - `ZCodeProviderAuth.getQuota` in `zcode-auth.provider.ts`
 * - `provider-token-usage.service.ts` via provider registry
 *
 * @module zcode-quota.provider
 */

import { randomUUID } from 'node:crypto';

import type {
  ProviderQuotaBucket,
  ProviderQuotaData,
  ProviderQuotaGroup,
  ProviderQuotaResetConsumeInput,
  ProviderQuotaResetConsumeResult,
  ProviderQuotaResetCredit,
  ProviderQuotaResetCredits,
} from '@/shared/types.js';
import {
  createProviderQuotaCache,
  pickAvailableResetCredit,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { readDecryptedZCodeCredentials } from './zcode-credentials.js';

export type ZCodeQuotaDependencies = {
  fetch: typeof globalThis.fetch;
  readCredentials: typeof readDecryptedZCodeCredentials;
  now: () => number;
};

const DEFAULT_DEPENDENCIES: ZCodeQuotaDependencies = {
  fetch: globalThis.fetch,
  readCredentials: readDecryptedZCodeCredentials,
  now: () => Date.now(),
};

const BIGMODEL_QUOTA_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
// Reset-card ("用量重置额度") endpoints behind the coding-plan console; only the
// personal plan segment is wired up — team accounts need org/project ids.
const BIGMODEL_RESET_LIST_URL = 'https://bigmodel.cn/api/biz/customer-package-reset/list';
const BIGMODEL_RESET_USE_URL = 'https://bigmodel.cn/api/biz/customer-package-reset/use';
const RESET_TARGET_TYPE = 'PERSONAL';
const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

const quotaCache = createProviderQuotaCache<ProviderQuotaData>(CACHE_TTL_MS);

/**
 * Resets the in-memory quota cache. Used in tests to ensure isolation.
 */
export function clearZCodeQuotaCache(): void {
  quotaCache.reset();
}

type RawZCodeLimit = {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails?: Array<{ modelCode?: string; usage?: number }>;
};

/**
 * Safely parses an optional epoch timestamp into an ISO string.
 * Returns undefined when invalid or not a positive finite number.
 */
function toSafeIsoDate(timestamp: unknown): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Maps ZCode raw limit entries to unified ProviderQuotaBucket items.
 */
function normalizeQuotaLimit(limit: RawZCodeLimit): ProviderQuotaBucket | null {
  const type = readOptionalString(limit.type);
  if (!type) {
    return null;
  }

  const nextResetIso = toSafeIsoDate(limit.nextResetTime);

  if (type === 'TOKENS_LIMIT') {
    const rawPercentage = Number(limit.percentage);
    const percentage = Number.isFinite(rawPercentage) ? rawPercentage : 0;
    const remainingFraction = Math.max(0, Math.min(1, (100 - percentage) / 100));
    const isFiveHour = limit.unit === 3 || limit.number === 5;

    return {
      id: isFiveHour ? 'zcode-5h-tokens' : 'zcode-tokens-limit',
      name: isFiveHour ? 'Five Hour Limit Remaining' : 'Token Limit Remaining',
      description: isFiveHour ? '5-hour rolling token limit' : 'Model token rate limit',
      window: isFiveHour ? '5h' : 'rolling',
      remainingFraction,
      resetTime: nextResetIso,
    };
  }

  if (type === 'TIME_LIMIT') {
    const rawUsage = Number(limit.usage);
    const usageTotal = Number.isFinite(rawUsage) ? rawUsage : 0;

    const rawRemaining = Number(limit.remaining);
    const remaining = Number.isFinite(rawRemaining) ? rawRemaining : 0;

    const rawPercentage = Number(limit.percentage);
    const percentage = Number.isFinite(rawPercentage) ? rawPercentage : 0;

    const remainingFraction = usageTotal > 0
      ? Math.max(0, Math.min(1, remaining / usageTotal))
      : Math.max(0, Math.min(1, (100 - percentage) / 100));

    return {
      id: 'zcode-calls-limit',
      name: 'Cycle Calls Limit',
      description: limit.usageDetails && limit.usageDetails.length > 0
        ? `${remaining} of ${usageTotal} calls remaining`
        : 'Cycle model and tool call quota',
      window: 'cycle',
      remainingFraction,
      resetTime: nextResetIso,
    };
  }

  return null;
}

/**
 * Normalizes raw API response to unified ProviderQuotaData.
 */
function normalizeQuotaPayload(
  payload: unknown,
  providerFamily: 'bigmodel' | 'zai',
  nowTimestamp: number,
): ProviderQuotaData | null {
  const record = readObjectRecord(payload);
  if (!record) {
    return null;
  }

  const data = readObjectRecord(record.data);
  if (!data || !Array.isArray(data.limits)) {
    return null;
  }

  const buckets = data.limits
    .map((item) => normalizeQuotaLimit(item as RawZCodeLimit))
    .filter((bucket): bucket is ProviderQuotaBucket => bucket !== null);

  if (buckets.length === 0) {
    return null;
  }

  const rawLevel = readOptionalString(data.level);
  const levelLabel = rawLevel ? rawLevel.toUpperCase() : null;
  const groupName = levelLabel
    ? `ZCode (${levelLabel})`
    : 'ZCode';

  const group: ProviderQuotaGroup = {
    name: groupName,
    description: providerFamily === 'zai' ? 'Z.AI Coding Plan account quota' : 'BigModel Coding Plan account quota',
    buckets,
  };

  return {
    groups: [group],
    updatedAt: new Date(nowTimestamp).toISOString(),
    // One family (GLM), split by allowance rather than by model family.
    partitioning: 'bucket',
  };
}

/**
 * Fetches current ZCode account quota status.
 *
 * Consumer: ZCodeProviderAuth.getQuota and provider-token-usage.service.
 */
export async function fetchZCodeQuota(
  options: { forceRefresh?: boolean } = {},
  dependencyOverrides: Partial<ZCodeQuotaDependencies> = {},
): Promise<ProviderQuotaData | null> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };

  return quotaCache.get(
    options,
    async () => {
      const credentials = await deps.readCredentials();
      if (!credentials.authenticated || !credentials.accessToken) {
        return null;
      }

      const targetUrl = credentials.providerFamily === 'zai' ? ZAI_QUOTA_URL : BIGMODEL_QUOTA_URL;

      try {
        const [limitsResult, resetResult] = await Promise.allSettled([
          readLimitsPayload(deps, credentials.providerFamily, credentials.accessToken),
          readResetCreditsQuietly(deps, credentials.accessToken),
        ]);

        if (limitsResult.status === 'rejected') {
          // Fail closed: network timeouts or errors degrade gracefully to null
          return null;
        }

        const normalized = normalizeQuotaPayload(
          limitsResult.value,
          credentials.providerFamily,
          deps.now(),
        );
        if (!normalized) {
          return null;
        }

        // The reset-card inventory rides along when it can be read; a failing
        // card request must never take the quota display down with it.
        const resetCredits = resetResult.status === 'fulfilled' ? resetResult.value : undefined;
        return resetCredits ? { ...normalized, resetCredits } : normalized;
      } catch {
        return null;
      }
    },
    deps.now,
  );
}

/**
 * Reads the raw limits payload from the family-matched quota endpoint.
 * Rejects on transport errors and non-OK statuses so the caller can decide
 * between "no quota" and "quota unavailable".
 */
async function readLimitsPayload(
  deps: ZCodeQuotaDependencies,
  providerFamily: 'bigmodel' | 'zai',
  accessToken: string,
): Promise<unknown> {
  const targetUrl = providerFamily === 'zai' ? ZAI_QUOTA_URL : BIGMODEL_QUOTA_URL;
  const response = await deps.fetch(targetUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Quota endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Reads the personal plan's reset-card inventory ("用量重置额度" cards) from the
 * coding-plan console API. Both card sections map onto the shared wire model:
 * `fiveHourResets` restore the 5-hour window, `weekResets` the weekly one (a
 * weekly reset also refills the 5-hour pool on the provider side). Returns
 * undefined when the account holds no spendable card or the read fails.
 */
async function readResetCreditsQuietly(
  deps: ZCodeQuotaDependencies,
  accessToken: string,
): Promise<ProviderQuotaResetCredits | undefined> {
  try {
    const credits = await fetchZCodeResetCreditList(deps, accessToken);
    return credits.length > 0 ? { credits } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Raw entry of `GET /biz/customer-package-reset/list`. `expireTime` comes as
 * `"YYYY-MM-DD HH:mm:ss"` in the account's local time.
 */
type RawZCodeResetRecord = {
  recordId?: unknown;
  grantType?: unknown;
  expireTime?: unknown;
  available?: unknown;
};

/**
 * Converts bigmodel's `"YYYY-MM-DD HH:mm:ss"` card expiry into ISO so every
 * client can `new Date()` it. The string carries no zone, so the server's own
 * zone is the assumption; anything unparseable passes through untouched.
 */
function normalizeZCodeTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return value;
  }
  const parsed = new Date(value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

async function fetchZCodeResetCreditList(
  deps: ZCodeQuotaDependencies,
  accessToken: string,
): Promise<ProviderQuotaResetCredit[]> {
  const response = await deps.fetch(
    `${BIGMODEL_RESET_LIST_URL}?targetType=${RESET_TARGET_TYPE}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  // Deliberately not a silent []: the consume path must distinguish "no
  // cards" from "cannot read the cards" before spending anything.
  if (!response.ok) {
    throw new Error(`Reset card endpoint returned HTTP ${response.status}`);
  }

  const payload = readObjectRecord(await response.json());
  const data = readObjectRecord(payload?.data);
  const sections: Array<[string, ProviderQuotaResetCredit['resetType']]> = [
    ['fiveHourResets', '5h'],
    ['weekResets', 'weekly'],
  ];

  const credits: ProviderQuotaResetCredit[] = [];
  for (const [key, resetType] of sections) {
    const list = Array.isArray(data?.[key]) ? data[key] : [];
    for (const entry of list) {
      const record = readObjectRecord(entry) as RawZCodeResetRecord | null;
      const recordId = record ? Number(record.recordId) : Number.NaN;
      if (!record || !Number.isFinite(recordId)) {
        continue;
      }

      const expireTime = readOptionalString(record.expireTime);
      const grantType = readOptionalString(record.grantType);
      credits.push({
        id: String(recordId),
        resetType,
        ...(grantType ? { grantType } : {}),
        available: record.available === true,
        ...(expireTime ? { expireTime: normalizeZCodeTimestamp(expireTime) } : {}),
      });
    }
  }

  return credits;
}

/**
 * Spends one of the account's reset cards through the coding-plan console.
 *
 * Reads the fresh card list first (the quota cache may be 30 seconds stale and
 * offer a card spent elsewhere), picks the soonest-expiring available card
 * covering the request, and posts the irreversible use request with a
 * `requestId` idempotency key. A successful spend invalidates the quota cache
 * so the next read reflects the refilled windows.
 *
 * Failures keep the cause distinguishable (`code`): "no cards" is different
 * from "cannot read the cards", and a timeout maps to `unknown` because the
 * card may already have been spent provider-side — the UI must steer the user
 * into re-checking the quota instead of retrying into a double spend.
 * Consumer: ZCodeProviderAuth.consumeQuotaReset().
 */
export async function consumeZCodeQuotaReset(
  input: ProviderQuotaResetConsumeInput,
  dependencyOverrides: Partial<ZCodeQuotaDependencies> = {},
): Promise<ProviderQuotaResetConsumeResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };

  const credentials = await deps.readCredentials();
  if (!credentials.authenticated || !credentials.accessToken) {
    return { ok: false, code: 'notAuthenticated', message: 'ZCode is not authenticated.' };
  }

  let credits: ProviderQuotaResetCredit[];
  try {
    credits = await fetchZCodeResetCreditList(deps, credentials.accessToken);
  } catch (error) {
    return {
      ok: false,
      code: 'readFailed',
      message: error instanceof Error ? error.message : 'Could not read the reset card list.',
    };
  }

  const card = pickAvailableResetCredit(credits, input.resetType);
  if (!card) {
    return { ok: false, code: 'noCard', message: 'No available quota reset card for this request.' };
  }

  try {
    const response = await deps.fetch(BIGMODEL_RESET_USE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetType: RESET_TARGET_TYPE,
        resetType: input.resetType === 'weekly' ? 'WEEK' : 'FIVE_HOUR',
        recordId: Number(card.id),
        grantType: card.grantType,
        requestId: randomUUID(),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const payload = readObjectRecord(await response.json().catch(() => null));
    if (response.ok && payload?.code === 200 && payload?.success === true) {
      quotaCache.reset();
      return {
        ok: true,
        code: 'reset',
        message: input.resetType === 'weekly'
          ? 'Weekly allowance was reset.'
          : '5-hour allowance was reset.',
      };
    }

    return {
      ok: false,
      code: 'spendFailed',
      message: readOptionalString(payload?.msg) ?? `Reset failed (HTTP ${response.status}).`,
    };
  } catch {
    return { ok: false, code: 'unknown', message: 'ZCode reset request did not confirm.' };
  }
}

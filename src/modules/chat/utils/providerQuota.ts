/**
 * Supported providers with account-level quota reporting capabilities.
 *
 * Used by CommandResultModal to determine whether to render the quota card.
 */
export type QuotaProvider = 'antigravity' | 'codex' | 'zcode';

const QUOTA_PROVIDERS = new Set<string>(['antigravity', 'codex', 'zcode']);

/**
 * Resolves whether a provider supports account-level quota reporting.
 *
 * Used by CommandResultModal in the chat module.
 */
export function resolveQuotaProvider(provider: string | undefined): QuotaProvider | null {
  return provider && QUOTA_PROVIDERS.has(provider) ? provider as QuotaProvider : null;
}

/**
 * Builds the backend URL to query account quota for a supported provider.
 *
 * Used by CommandResultModal in the chat module.
 */
export function buildProviderQuotaUrl(provider: QuotaProvider, forceRefresh = false): string {
  const searchParams = new URLSearchParams({ provider });
  if (forceRefresh) {
    searchParams.set('refresh', 'true');
  }
  return `/api/providers/quota?${searchParams.toString()}`;
}

/** Returns null when the model doesn't belong to any known family bucket. */
function matchesFamily(groupText: string, normalizedModel: string): boolean | null {
  if (normalizedModel.includes('gemini')) {
    return groupText.includes('gemini');
  }
  if (normalizedModel.includes('claude') || normalizedModel.includes('gpt')) {
    return groupText.includes('claude') || groupText.includes('gpt');
  }
  if (normalizedModel.includes('glm')) {
    return groupText.includes('glm') || groupText.includes('zcode');
  }
  return null;
}

/**
 * Determines whether a quota group corresponds to the active session model.
 *
 * Rules:
 * 1. If provider only has 1 quota group (e.g. Codex, ZCode), it represents the active session.
 * 2. Antigravity splits quota into groups by model family (Gemini vs Claude/GPT); every
 *    group's own text names its family, so a family keyword match reliably tells them apart.
 * 3. Codex/ZCode instead split quota into buckets of the same family — e.g. Codex's
 *    "gpt-reserve" bucket is a carve-out that only backs gpt-5.6-luna, sitting alongside the
 *    main pool though both are GPT. A family match would wrongly tag the reserve bucket as
 *    active for every GPT model, so for these providers a bucket's own text must explicitly
 *    name the current model to win the "reserve" (or otherwise unmatched) bucket; an unmatched
 *    bucket that isn't a reserve carve-out falls back to being the account's general-purpose
 *    pool.
 */
export function resolveIsActiveQuotaGroup(
  currentModel: string | undefined,
  group: { name: string; description?: string },
  totalGroupsCount: number,
  provider?: string,
): boolean {
  if (totalGroupsCount <= 1) {
    return true;
  }

  const groupText = `${group.name} ${group.description || ''}`.toLowerCase();
  const normalizedModel = (currentModel || '').toLowerCase();
  const bucketPartitioned = provider === 'codex' || provider === 'zcode';

  if (bucketPartitioned && groupText.includes('reserve')) {
    return Boolean(normalizedModel) && groupText.includes(normalizedModel);
  }

  const familyMatch = matchesFamily(groupText, normalizedModel);
  if (familyMatch !== null) {
    if (familyMatch) {
      return true;
    }
    if (!bucketPartitioned) {
      return false;
    }
    // Bucket-partitioned providers: the family keyword missed (e.g. Codex's
    // main pool is just called "Codex (Plus)") — fall through below.
  }

  if (normalizedModel && groupText.includes(normalizedModel)) {
    return true;
  }

  // Bucket-partitioned providers with no family or model mention at all:
  // treat this non-reserve bucket as the account's general-purpose pool.
  return bucketPartitioned && familyMatch !== null && Boolean(normalizedModel);
}

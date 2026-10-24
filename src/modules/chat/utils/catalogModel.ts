import type { ProviderModelOption } from '@/shared/types';

const ONE_MILLION_CONTEXT_SUFFIX = '[1m]';

/**
 * The catalog entry a saved model choice stands for: the exact id, or the base entry for a
 * 1M alias such as `opus[1m]`. Claude Code dropped its separate 1M entries once its base
 * aliases ran at 1M context (measured on 2.1.303: `opus` and `opus[1m]` both report a
 * 1,000,000-token window), so an old saved choice maps onto its base model without loss.
 * Used by chat's provider state (saved choices, effort tiers) and its model menu.
 */
export const findCatalogModelOption = (
  options: readonly ProviderModelOption[],
  model: string | null | undefined,
): ProviderModelOption | null => {
  if (!model) return null;
  const exact = options.find((option) => option.value === model);
  if (exact) return exact;
  if (!model.endsWith(ONE_MILLION_CONTEXT_SUFFIX)) return null;
  const base = model.slice(0, -ONE_MILLION_CONTEXT_SUFFIX.length);
  return options.find((option) => option.value === base) ?? null;
};

import fsSync from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  readTrimmedStringRecord,
} from '@/shared/utils.js';

import { readZCodeIndividualPlanAuthContext, readDecryptedZCodeJwtToken } from './zcode-credentials.js';
import { getZCodeDatabasePath, getZCodeStorageDir } from './zcode-data-root.js';
import {
  readZCodeIndividualPlanModelIds,
  readZCodeModelContextWindow,
  readZCodeModelReasoningValues,
  readZCodeTemplateModelDefaults,
  resolveZCodeProviderApiType,
} from './zcode-provider-config.js';
import { tryResolveEnginePath } from './zcode-engine-path.js';
import { protocolClient } from './zcode-protocol.client.js';

/**
 * Account id of the BigModel trial plan (体验套餐). The picker keys its pinned
 * option by it, the send resolver routes it to the trial quota, and the
 * runtime header bridge answers it with the trial JWT.
 */
export const ZCODE_START_PLAN_PROVIDER_ID = 'account:bigmodel-start-plan';
/** Used by the send model resolver and runtime header bridge to keep account identity consistent. */
export const ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID = 'account:bigmodel-individual-coding-plan';
const ZCODE_START_PLAN_MODEL_ID = 'GLM-5.3-Flash';
const ZCODE_START_PLAN_MODEL_VALUE = `${ZCODE_START_PLAN_PROVIDER_ID}/${ZCODE_START_PLAN_MODEL_ID}`;
const ZCODE_START_PLAN_MODEL_LABEL = 'GLM-5.3-Flash（体验）';
/** Plan catalog fallback for installs without a readable builtin config. */
const ZCODE_PERSONAL_MODELS_FALLBACK = new Set(['GLM-5.3', 'GLM-5.3-Flash']);

/**
 * Plan models the installed engine grants: the individual plan's
 * `builtinModelIds` from the resolved builtin config (runtime-synced cache
 * first, engine-bundled file second), or the pinned fallback when neither is
 * readable. Filters the picker's plan entries and routes bare plan ids, so
 * engine-added models (GLM-5.4 …) appear without a cloudcli release while
 * stale ids (GLM-4.7 …) stay out.
 */
function getPersonalPlanModelIds(): Set<string> {
  return readZCodeIndividualPlanModelIds() ?? ZCODE_PERSONAL_MODELS_FALLBACK;
}

/** Legacy provider ids that name the personal ("coding plan") provider family. */
function isPersonalPlanProviderId(providerId: string): boolean {
  return providerId === 'bigmodel-coding-plan' || providerId === 'builtin:bigmodel-coding-plan';
}

/**
 * Static fallback catalog used when the engine's model config cannot be read.
 * Exported for the capability tests: the capability catalog's defaultModel is
 * pinned to this definition's DEFAULT.
 */
export const ZCODE_BUILTIN_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'GLM-5.3',
      label: 'GLM-5.3',
      description: 'ZCode default model with 1M context window and 128K output tokens',
      effort: {
        default: 'max',
        values: [
          { value: 'low', description: 'Faster, less detailed reasoning' },
          { value: 'high', description: 'Balanced reasoning for most tasks' },
          { value: 'max', description: 'Maximum reasoning for complex tasks' },
        ],
      },
    },
  ],
  DEFAULT: 'GLM-5.3-Flash',
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: 'Faster, less detailed reasoning',
  high: 'Balanced reasoning for most tasks',
  max: 'Maximum reasoning for complex tasks',
};

/** Reasoning levels listed weakest first; unknown levels sort after, alphabetically. */
const REASONING_EFFORT_ORDER: Record<string, number> = {
  low: 10,
  medium: 20,
  high: 30,
  max: 40,
};

/** disabled/enabled-only option lists are engine thinking toggles, not effort pickers. */
function isToggleOnlyReasoning(values: string[]): boolean {
  return values.every((value) => value === 'disabled' || value === 'enabled');
}

function sortReasoningValues(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const orderA = REASONING_EFFORT_ORDER[a] ?? 999;
    const orderB = REASONING_EFFORT_ORDER[b] ?? 999;
    if (orderA !== orderB) return orderA - orderB;
    return a.localeCompare(b);
  });
}

/**
 * Level used when the composer carried none. The engine requires
 * `options.reasoningLevel` for any model shipping a reasoning spec, so
 * something must be picked: the top effort (highest sorted value, which
 * lands on max → xhigh before exotic ids), and thinking-off for toggle-only
 * specs. Null without a spec — nothing is invented.
 */
function pickNativeReasoningDefault(values: string[]): string | null {
  const efforts = values.filter((value) => value !== 'disabled' && value !== 'enabled');
  if (efforts.length > 0) return sortReasoningValues(efforts).at(-1) ?? null;
  if (values.includes('disabled')) return 'disabled';
  if (values.includes('enabled')) return 'enabled';
  return null;
}

/** Menu effort from engine reasoning specs; toggle-only specs stay off the picker. */
function buildNativeReasoningEffort(values: string[]): ProviderModelOption['effort'] | undefined {
  if (values.length === 0 || isToggleOnlyReasoning(values)) return undefined;
  const fallback = pickNativeReasoningDefault(values);
  return {
    ...(fallback ? { default: fallback } : {}),
    values: sortReasoningValues(values).map((value) => ({
      value,
      description: EFFORT_DESCRIPTIONS[value] || `${value} reasoning level`,
    })),
  };
}

/**
 * One personal provider parsed from ZCode's native `v2/provider_config.json`
 * (what the ZCode App provider settings page writes). `modelIds` is the
 * enabled catalog in display order; `apiKeyConfigured` marks the rule that
 * carries api-key access. Consumers: `readZCodeModelConfig` (catalog merge),
 * `resolveZCodeModelRef` (bare-id routing) and `buildNativePersonalSendParams`
 * (send params) below — kept module-private.
 *
 * The engine loads this file (or a materialized copy that preserves its
 * rules) as the personal provider registry at spawn, so cloudcli only has to
 * list and route the ids; the credential never transits send params.
 */
type NativePersonalProviderRule = {
  providerId: string;
  providerName: string;
  modelIds: string[];
  apiKeyConfigured: boolean;
};

function readNativePersonalProviderRules(): NativePersonalProviderRule[] {
  let body: Record<string, unknown> | null = null;
  try {
    const root = readObjectRecord(JSON.parse(fsSync.readFileSync(
      path.join(getZCodeStorageDir(), 'v2', 'provider_config.json'),
      'utf8',
    )));
    body = readObjectRecord(root?.config);
  } catch {
    // Missing or unreadable native config: no personal providers.
    return [];
  }

  const providerRules = Array.isArray(readObjectRecord(body?.providerConfigRules)?.providerRules)
    ? readObjectRecord(body?.providerConfigRules)?.providerRules as unknown[]
    : [];
  const modelRules = Array.isArray(readObjectRecord(body?.modelConfigRules)?.providerModelRules)
    ? readObjectRecord(body?.modelConfigRules)?.providerModelRules as unknown[]
    : [];
  const manualRules = Array.isArray(readObjectRecord(body?.modelConfigRules)?.manualProviderModelRules)
    ? readObjectRecord(body?.modelConfigRules)?.manualProviderModelRules as unknown[]
    : [];

  const collectStringList = (value: unknown): string[] => (
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
  );

  const templateDefaults = readZCodeTemplateModelDefaults();
  const rules: NativePersonalProviderRule[] = [];
  for (const entry of providerRules) {
    const record = readObjectRecord(entry);
    const providerId = readOptionalString(record?.providerId);
    if (!providerId || record?.enabled === false) continue;
    // Account/builtin rows are the plans' or ZCode's own registry, and the
    // legacy `bigmodel-coding-plan` row keeps plan routing authority; none of
    // them belong to the native personal-provider list.
    if (providerId.startsWith('builtin:')
      || providerId.startsWith('account:')
      || providerId === 'bigmodel-coding-plan') continue;

    const config = readObjectRecord(record?.config);
    const templateId = readOptionalString(record?.templateId) || providerId;
    const templateModels = templateDefaults?.get(templateId) ?? null;
    const personalModelIds = collectStringList(config?.personalModelIds);

    // Mirrors the App model page, which shows exactly this overlay: user
    // deviation rules first, then user-added personal models (listed only
    // when picked, so membership means enabled), then the engine template's
    // shipped defaults. When the template defaults are entirely unavailable
    // (no engine, no builtin rows) stay permissive rather than hiding the
    // whole group.
    const isModelEnabled = (modelId: string): boolean => {
      for (const modelEntry of modelRules) {
        const modelRecord = readObjectRecord(modelEntry);
        if (readOptionalString(modelRecord?.providerId) === providerId
          && readOptionalString(modelRecord?.modelId) === modelId) {
          return readObjectRecord(modelRecord?.config)?.enabled !== false;
        }
      }
      if (personalModelIds.includes(modelId)) return true;
      if (templateModels) return templateModels.get(modelId) === true;
      return true;
    };

    const modelIds: string[] = [];
    const addModel = (modelId: string) => {
      if (!modelIds.includes(modelId)) modelIds.push(modelId);
    };
    const pushModel = (modelId: string) => {
      if (isModelEnabled(modelId)) addModel(modelId);
    };
    // modelOrder first (the App's display order), then ids it omits.
    collectStringList(config?.modelOrder).forEach(pushModel);
    personalModelIds.forEach(pushModel);
    for (const manualEntry of manualRules) {
      const manualRecord = readObjectRecord(manualEntry);
      if (readOptionalString(manualRecord?.providerId) !== providerId) continue;
      if (readObjectRecord(manualRecord?.config)?.enabled === false) continue;
      const manualModelId = readOptionalString(manualRecord?.modelId);
      // The manual row itself is the user's explicit enable signal; skip the
      // template consult (manual models are not template catalog members).
      if (manualModelId) addModel(manualModelId);
    }
    if (modelIds.length === 0) continue;

    const access = readObjectRecord(config?.access);
    rules.push({
      providerId,
      providerName: readOptionalString(record?.providerName) || providerId,
      modelIds,
      apiKeyConfigured: readOptionalString(access?.type) === 'api-key'
        && Boolean(readOptionalString(access?.apiKey)),
    });
  }
  return rules;
}

/**
 * Send params for a selection whose authoritative config is the native
 * personal provider file. Only the selection travels: the engine resolves
 * the api key from the personal config handed to it at spawn, so the
 * credential is never copied into send params. The engine hard-requires
 * `options.reasoningLevel` for models that ship a reasoning spec, so when
 * the composer carried none the top spec level is filled in. Returns null
 * (engine default model, the existing degrade philosophy) when the
 * provider/model is not in the native config or lacks api-key access.
 *
 * Consumer: `buildZCodeSendModelParams` below.
 */
function buildNativePersonalSendParams(
  explicitSelection: { providerId: string; modelId: string; options?: { reasoningLevel: string } },
): {
  modelSelection: { providerId: string; modelId: string; options?: { reasoningLevel: string } };
  modelExecution: { selectionScope: 'execution' };
} | null {
  const rule = readNativePersonalProviderRules().find((candidate) => (
    candidate.providerId === explicitSelection.providerId
    && candidate.modelIds.includes(explicitSelection.modelId)
  ));
  if (!rule || !rule.apiKeyConfigured) return null;
  const modelSelection = { ...explicitSelection };
  if (!modelSelection.options?.reasoningLevel) {
    const values = readZCodeModelReasoningValues(explicitSelection.modelId) ?? [];
    const fallback = values.length > 0 ? pickNativeReasoningDefault(values) : null;
    if (fallback) modelSelection.options = { reasoningLevel: fallback };
  }
  return {
    modelSelection,
    modelExecution: { selectionScope: 'execution' },
  };
}

/** Plan provider rows in `cli/config.json` — never a catalog source, see readZCodeModelConfig. */
function isPlanProviderRow(providerId: string): boolean {
  return providerId === 'bigmodel-coding-plan'
    || providerId.startsWith('builtin:bigmodel')
    || providerId.startsWith('account:bigmodel-coding-plan')
    || providerId.startsWith('account:bigmodel-individual');
}

/**
 * Appends the pinned trial-plan option when the account holds a trial JWT.
 * The trial model stays a single hard-coded entry: the plan's billing API
 * cannot be turned into a usable model catalog, so the plan grants exactly
 * this Flash model. Kept ungrouped so the menu stays flat like claude's.
 *
 * The engine-resolved catalog lists it naturally once entitled; this only
 * covers the on-disk fallback path.
 */
function appendStartPlanModelIfEligible(options: ProviderModelOption[]): ProviderModelOption[] {
  const jwtToken = readDecryptedZCodeJwtToken();
  if (!jwtToken || options.some((opt) => opt.value === ZCODE_START_PLAN_MODEL_VALUE)) {
    return options;
  }
  return [
    ...options,
    {
      value: ZCODE_START_PLAN_MODEL_VALUE,
      label: ZCODE_START_PLAN_MODEL_LABEL,
      description: 'ZCode 体验套餐专享模型',
      effort: {
        default: 'max',
        values: [
          { value: 'low', description: EFFORT_DESCRIPTIONS.low },
          { value: 'high', description: EFFORT_DESCRIPTIONS.high },
          { value: 'max', description: EFFORT_DESCRIPTIONS.max },
        ],
      },
    },
  ];
}

/**
 * Reads the model catalog. Membership comes from a single authority per
 * source: account-plan models are the builtin config's plan catalog
 * (`account:bigmodel-individual-coding-plan` `builtinModelIds`, runtime-synced
 * cache first), user-configured custom providers come from
 * `cli/config.json`, and ZCode App personal providers (`v2/provider_config.json`)
 * merge in grouped after both. `cli/config.json` no longer decides plan
 * membership — it only enriches a plan model's description/effort when the
 * engine has materialized a record for the same id, so engine-added models
 * appear immediately and stale ids stay out. On a bare-key collision the plan
 * entry wins and cli custom entries yield, matching the send routing in
 * `resolveZCodeModelRef`.
 */
const readZCodeModelConfig = async (): Promise<ProviderModelsDefinition> => {
  const modelOptions: ProviderModelOption[] = [];
  const seenModelKeys = new Set<string>();
  const cliModelRecords = new Map<string, Record<string, unknown>>();

  /** Option from a cli/config.json model record (same parsing as before). */
  const buildOptionFromRecord = (
    modelKey: string,
    modelRecord: Record<string, unknown>,
    group: string | undefined,
  ): ProviderModelOption => {
    const reasoning = readObjectRecord(modelRecord.reasoning);
    const variants = Array.isArray(reasoning?.levels) ? reasoning.levels : reasoning?.variants;
    const hasReasoning = Array.isArray(variants) && variants.length > 0;

    const limits = readObjectRecord(modelRecord.limit);
    const contextLimit = limits?.context;
    const outputLimit = limits?.output;

    const limitDescriptions: string[] = [];
    if (typeof contextLimit === 'number') {
      limitDescriptions.push(`${(contextLimit / 1000).toFixed(0)}K context`);
    }
    if (typeof outputLimit === 'number') {
      limitDescriptions.push(`${(outputLimit / 1000).toFixed(0)}K output`);
    }

    const description = limitDescriptions.length > 0
      ? `ZCode model with ${limitDescriptions.join(', ')}`
      : `ZCode ${modelKey} model`;

    let effort: ProviderModelOption['effort'] | undefined;
    if (hasReasoning && Array.isArray(variants)) {
      const sortedVariants = variants
        .filter((variant): variant is string => typeof variant === 'string' && variant.trim().length > 0)
        .map((variant) => variant.trim().toLowerCase())
        .sort((a, b) => {
          const orderA = REASONING_EFFORT_ORDER[a] ?? 999;
          const orderB = REASONING_EFFORT_ORDER[b] ?? 999;
          if (orderA !== orderB) return orderA - orderB;
          return a.localeCompare(b);
        });
      effort = {
        default: readOptionalString(reasoning?.defaultLevel)?.toLowerCase() ?? 'max',
        values: sortedVariants.map((variant: string) => {
          const normalized = variant.toLowerCase();
          return {
            value: normalized,
            description: EFFORT_DESCRIPTIONS[normalized] || `${normalized} reasoning level`,
          };
        }),
      };
    }

    return {
      value: modelKey,
      label: modelKey,
      ...(group ? { group } : {}),
      description: readOptionalString(modelRecord.description) || description,
      effort: hasReasoning ? effort : undefined,
    };
  };

  /** Plan option without a cli record: metadata come from the builtin table rows. */
  const buildPlanOptionFromBuiltinTable = (modelId: string): ProviderModelOption => {
    const reasoningValues = readZCodeModelReasoningValues(modelId);
    const effort = reasoningValues ? buildNativeReasoningEffort(reasoningValues) : undefined;
    const contextWindow = readZCodeModelContextWindow(modelId);
    return {
      value: modelId,
      label: modelId,
      description: contextWindow
        ? `ZCode model with ${(contextWindow / 1000).toFixed(0)}K context`
        : `ZCode ${modelId} model`,
      ...(effort ? { effort } : {}),
    };
  };

  /** Plan option without a cli record: the static fallback entry first, then the builtin table. */
  const buildPlanOption = (modelId: string): ProviderModelOption => {
    const fallbackEntry = ZCODE_BUILTIN_MODELS.OPTIONS.find((option) => option.value === modelId);
    if (fallbackEntry) return fallbackEntry;
    return buildPlanOptionFromBuiltinTable(modelId);
  };

  const planRecords = new Map<string, Record<string, unknown>>();
  const planOwnedKeys = new Set<string>();
  const customOwnedKeys = new Set<string>();
  const customEntries: { modelKey: string; option: ProviderModelOption }[] = [];

  try {
    const config = readObjectRecord(JSON.parse(
      await readFile(path.join(getZCodeStorageDir(), 'cli', 'config.json'), 'utf8')
    ));

    const providers = readObjectRecord(config?.provider);
    if (providers) {
      for (const [providerId, providerConfig] of Object.entries(providers)) {
        const providerRecord = readObjectRecord(providerConfig);
        // Skip explicitly disabled providers
        if (providerRecord?.enabled === false) continue;

        const models = readObjectRecord(providerRecord?.models);
        if (!models) continue;

        const isPlanRow = isPlanProviderRow(providerId);
        const group = isPlanRow
          ? undefined
          : (readOptionalString(providerRecord?.name) || providerId);

        for (const [modelKey, modelConfig] of Object.entries(models)) {
          const modelRecord = readObjectRecord(modelConfig);
          if (!modelRecord) continue;
          if (!cliModelRecords.has(modelKey)) cliModelRecords.set(modelKey, modelRecord);
          // First listing provider owns the key; a later same-key row in the
          // other family neither re-enriches nor duplicates the entry.
          if (planOwnedKeys.has(modelKey) || customOwnedKeys.has(modelKey)) continue;
          if (isPlanRow) {
            planOwnedKeys.add(modelKey);
            planRecords.set(modelKey, modelRecord);
          } else {
            customOwnedKeys.add(modelKey);
            customEntries.push({ modelKey, option: buildOptionFromRecord(modelKey, modelRecord, group) });
          }
        }
      }
    }
  } catch {
    // Missing or unreadable engine config: the plan catalog still drives the menu.
  }

  // Plan models first so the flat head of the menu reads like claude's; a
  // catalog id owned by a custom provider is skipped (the custom entry below
  // covers it, matching the send routing's precedence).
  for (const planModelId of getPersonalPlanModelIds()) {
    if (customOwnedKeys.has(planModelId) || seenModelKeys.has(planModelId)) continue;
    seenModelKeys.add(planModelId);
    const record = planRecords.get(planModelId);
    modelOptions.push(record
      ? buildOptionFromRecord(planModelId, record, undefined)
      : buildPlanOption(planModelId));
  }
  for (const entry of customEntries) {
    if (seenModelKeys.has(entry.modelKey)) continue;
    seenModelKeys.add(entry.modelKey);
    modelOptions.push(entry.option);
  }

  // Merge providers configured in the ZCode App settings page. Their model
  // metadata carries no reasoning levels or limits, so options stay plain
  // entries grouped under the provider name.
  for (const rule of readNativePersonalProviderRules()) {
    for (const modelId of rule.modelIds) {
      if (seenModelKeys.has(modelId)) continue;
      seenModelKeys.add(modelId);
      const reasoningValues = readZCodeModelReasoningValues(modelId);
      const effort = reasoningValues ? buildNativeReasoningEffort(reasoningValues) : undefined;
      modelOptions.push({
        value: modelId,
        label: modelId,
        group: rule.providerName,
        description: `ZCode ${modelId} model`,
        ...(effort ? { effort } : {}),
      });
    }
  }

  // Model keys stay bare (`GLM-5.3`) so the picker reads like claude's and
  // antigravity's; the account scoping is applied at send resolution instead.
  // The trial plan is the one exception: its pinned option carries the scoped
  // id because the bare Flash id already belongs to the personal plan.
  // The default model stays anchored to the Flash entry so a catalog reorder
  // cannot drift it (the ZCode App's own default for the personal plan).
  return {
    OPTIONS: appendStartPlanModelIfEligible(modelOptions),
    DEFAULT: modelOptions.some((option) => option.value === 'GLM-5.3-Flash')
      ? 'GLM-5.3-Flash'
      : modelOptions[0]?.value ?? ZCODE_BUILTIN_MODELS.DEFAULT,
  };
};

/**
 * Default reasoning level per `providerId/modelId`, captured from the engine's
 * resolved catalog. `session/setModel` rejects a model that declares reasoning
 * levels unless one is supplied, so the runtime reads it from here when the
 * user did not pick an explicit effort.
 */
let engineReasoningDefaults = new Map<string, string>();

/**
 * Context window per `providerId/modelId`, captured from the engine's resolved
 * catalog (`settings.model.available[].contextWindow`). The engine resolves
 * every provider it can run — including user-added ones that never appear in
 * `v2/config.json`, which is where a session's own model key gets its window
 * from (`resolveZCodeModelContextWindow`).
 *
 * Consumers: `resolveZCodeModelContextWindow` (zcode context-usage reader).
 */
let engineContextWindows = new Map<string, number>();

/** In-flight/settled engine catalog load, shared across providers and runs. */
let engineCatalogPromise: Promise<ProviderModelsDefinition | null> | null = null;

/**
 * Maps an engine `session/create` (or `session/resume`) response into CloudCLI's
 * model catalog.
 *
 * The engine resolves every provider from its own builtin + personal config,
 * including user-added providers that never appear in `v2/config.json`, and
 * returns them on the session settings as `settings.model.available`. Values
 * are emitted as `providerId/modelId` so a bare model id shared by multiple
 * providers stays unambiguous.
 *
 * Consumers: `loadEngineModelCatalog`, `PrimeZCodeModelCatalog`, and
 * `ingestZCodeModelCatalog` (the runtime seeds it from responses it already
 * has, avoiding a redundant create).
 */
function mapEngineModelCatalog(result: AnyRecord | undefined | null): ProviderModelsDefinition | null {
  const settings = readObjectRecord(result?.settings);
  const modelSection = readObjectRecord(settings?.model);
  const available = modelSection?.available;
  if (!Array.isArray(available) || available.length === 0) {
    return null;
  }

  const options: ProviderModelOption[] = [];
  const reasoningDefaults = new Map<string, string>();
  const contextWindows = new Map<string, number>();
  const seenValues = new Set<string>();

  for (const entry of available) {
    const entryRecord = readObjectRecord(entry);
    const ref = readObjectRecord(entryRecord?.ref);
    const providerId = readOptionalString(ref?.providerId);
    const modelId = readOptionalString(ref?.modelId);
    if (!providerId || !modelId) continue;

    const value = `${providerId}/${modelId}`;
    if (seenValues.has(value)) continue;
    seenValues.add(value);

    const reasoning = readObjectRecord(entryRecord?.reasoning);
    const effortValues: { value: string; description: string }[] = [];
    if (Array.isArray(reasoning?.levels)) {
      for (const level of reasoning.levels) {
        const levelRecord = readObjectRecord(level);
        const levelValue = readOptionalString(levelRecord?.value);
        if (!levelValue) continue;
        effortValues.push({
          value: levelValue,
          description: readOptionalString(levelRecord?.label) ?? levelValue,
        });
      }
    }

    const defaultLevel = readOptionalString(reasoning?.defaultLevel)
      ?? effortValues[effortValues.length - 1]?.value;
    if (defaultLevel) {
      reasoningDefaults.set(value, defaultLevel);
    }

    const contextWindow = typeof entryRecord?.contextWindow === 'number' ? entryRecord.contextWindow : undefined;
    const maxOutputTokens = typeof entryRecord?.maxOutputTokens === 'number' ? entryRecord.maxOutputTokens : undefined;
    const providerLabel = readOptionalString(entryRecord?.providerLabel);
    if (contextWindow && contextWindow > 0) {
      contextWindows.set(value, contextWindow);
    }

    const descriptionParts: string[] = [];
    if (providerLabel) descriptionParts.push(providerLabel);
    if (contextWindow) descriptionParts.push(`${(contextWindow / 1000).toFixed(0)}K context`);
    if (maxOutputTokens) descriptionParts.push(`${(maxOutputTokens / 1000).toFixed(0)}K output`);

    options.push({
      value,
      label: readOptionalString(entryRecord?.label) ?? modelId,
      ...(descriptionParts.length > 0 ? { description: descriptionParts.join(' · ') } : {}),
      ...(effortValues.length > 0
        ? { effort: { default: defaultLevel, values: effortValues } }
        : {}),
    });
  }

  if (options.length === 0) {
    return null;
  }

  engineReasoningDefaults = reasoningDefaults;
  engineContextWindows = contextWindows;
  return { OPTIONS: options, DEFAULT: options[0].value };
}

/**
 * Seeds the shared reasoning-default map from a session response the runtime
 * already received.
 *
 * Consumer: `server/modules/providers/list/zcode/zcode-runtime.provider.ts`
 * (after `session/create` and `session/resume`), so `session/setModel` can
 * supply the required reasoning level without a second catalog request.
 */
export function ingestZCodeModelCatalog(result: AnyRecord | undefined | null): void {
  // Always re-map: the shared loader may have resolved to null before the
  // engine was reachable, and this response is a fresh, authoritative catalog.
  mapEngineModelCatalog(result);
}

/**
 * Loads the resolved model catalog from the engine.
 *
 * `session/create` is the only request that returns the workspace model
 * catalog (`settings.model.available`); the throwaway session is closed again
 * and never persists without a message. Returns null when the engine is not
 * installed or the response carries no catalog, so callers can fall back to
 * the on-disk config reader.
 *
 * Consumers: the `ZCodeProviderModels` default loader and
 * `primeZCodeModelCatalog`.
 */
async function loadEngineModelCatalog(): Promise<ProviderModelsDefinition | null> {
  if (!tryResolveEnginePath()) {
    return null;
  }

  try {
    const workspacePath = getZCodeStorageDir();
    const result = await protocolClient.sendRequest<AnyRecord>('session/create', {
      workspace: { workspacePath, workspaceKey: workspacePath },
    }, 15000);

    const sessionId = readOptionalString(readObjectRecord(result?.session)?.sessionId);
    if (sessionId) {
      try {
        await protocolClient.sendRequest('session/close', { sessionId }, 5000);
      } catch {
        // The throwaway session was never persisted; closing is best-effort.
      }
    }

    return mapEngineModelCatalog(result);
  } catch {
    return null;
  }
}

/**
 * Returns the shared engine catalog, loading it once per process.
 *
 * Consumers: `ZCodeProviderModels.getSupportedModels` (default loader) and
 * `resolveZCodeModelDefaultReasoningLevel` (runtime `session/setModel`).
 */
export function primeZCodeModelCatalog(): Promise<ProviderModelsDefinition | null> {
  if (!engineCatalogPromise) {
    engineCatalogPromise = loadEngineModelCatalog();
  }
  return engineCatalogPromise;
}

/**
 * Returns the engine default reasoning level for a model reference.
 *
 * Accepts the catalog value (`providerId/modelId`) or a bare model id; a bare
 * id only resolves when exactly one provider exposes it, mirroring
 * `canonicalizeProviderModel`. Consumers: the zcode runtime provider, which
 * must include a level on `session/setModel`.
 */
export function resolveZCodeModelDefaultReasoningLevel(modelKey: string): string | undefined {
  const normalized = modelKey.trim();
  if (!normalized) return undefined;

  const direct = engineReasoningDefaults.get(normalized);
  if (direct) return direct;

  const suffix = normalized.split('/').pop();
  if (!suffix) return undefined;

  let match: string | undefined;
  for (const [key, level] of engineReasoningDefaults) {
    if (key.split('/').pop() !== suffix) continue;
    if (match) return undefined; // Ambiguous across providers.
    match = level;
  }
  return match;
}

/**
 * Context window of one model, as the engine declared it.
 *
 * The engine-resolved catalog wins because it is the only source that knows
 * user-added providers (`opencode-go-chat/deepseek-v4.1-flash` never appears in
 * `v2/config.json`); the on-disk config is the fallback for a process that has
 * not resolved a catalog yet (a fresh server answering `/token-usage` before
 * the first models request or run).
 *
 * Consumer: the zcode context-usage reader, which needs a window to turn a
 * session's occupancy into a percentage.
 */
export function resolveZCodeModelContextWindow(modelKey: string): number | undefined {
  const normalized = modelKey.trim();
  if (!normalized) return undefined;

  const direct = engineContextWindows.get(normalized);
  if (direct) return direct;

  // Catalog values are `providerId/modelId`; a bare model id still resolves
  // when exactly one provider exposes it, mirroring the reasoning defaults.
  const suffix = normalized.split('/').pop();
  if (suffix) {
    let match: number | undefined;
    for (const [key, window] of engineContextWindows) {
      if (key.split('/').pop() !== suffix) continue;
      if (match) {
        match = undefined; // Ambiguous across providers.
        break;
      }
      match = window;
    }
    if (match) return match;
  }

  return readConfigContextWindow(suffix ?? normalized)
    ?? readZCodeModelContextLimit(suffix ?? normalized)
    ?? undefined;
}

/**
 * Parsed `limit.context` per bare model id from ZCode's v2 config, memoized by
 * file identity. The editor and the CLI rewrite that file when providers
 * change, so identity (mtime + size) is what invalidates the parse — not a TTL.
 */
let configContextWindowCache: { key: string; windows: Map<string, number> } | null = null;

function readConfigContextWindow(modelId: string): number | undefined {
  const configPath = path.join(getZCodeStorageDir(), 'v2', 'config.json');
  let cacheKey: string;
  try {
    const stats = fsSync.statSync(configPath);
    cacheKey = `${configPath}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return undefined;
  }

  if (configContextWindowCache?.key !== cacheKey) {
    try {
      const config = readObjectRecord(JSON.parse(fsSync.readFileSync(configPath, 'utf8')));
      const providers = readObjectRecord(config?.provider) ?? {};
      const windows = new Map<string, number>();
      for (const providerConfig of Object.values(providers)) {
        const models = readObjectRecord(readObjectRecord(providerConfig)?.models) ?? {};
        for (const [configModelId, modelConfig] of Object.entries(models)) {
          const contextLimit = readObjectRecord(readObjectRecord(modelConfig)?.limit)?.context;
          if (typeof contextLimit === 'number' && contextLimit > 0) {
            windows.set(configModelId, contextLimit);
          }
        }
      }
      configContextWindowCache = { key: cacheKey, windows };
    } catch {
      configContextWindowCache = null;
      return undefined;
    }
  }

  return configContextWindowCache?.windows.get(modelId);
}

/**
 * Reads the model a ZCode session last ran with from ZCode's own SQLite
 * store (most recent `message.data.modelID` per integration plan §3.2.5).
 *
 * Consumers: `ZCodeProviderModels.getCurrentActiveModel` (app session id
 * mapped to the provider id first) and the zcode runtime provider (which
 * already holds the provider session id and skips redundant `session/setModel`
 * calls when the requested model matches). Returns null when unknown.
 */
export function readZCodeSessionModelInfoFromDb(providerSessionId: string): { modelId: string; variant?: string } | null {
  const dbPath = getZCodeDatabasePath();

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const recentMessage = db
      .prepare(
        `SELECT data FROM message
         WHERE session_id = ?
         ORDER BY time_created DESC
         LIMIT 1`
      )
      .get(providerSessionId) as { data: string } | undefined;

    if (!recentMessage) {
      return null;
    }

    const messageData = readObjectRecord(JSON.parse(recentMessage.data));
    const modelRecord = readObjectRecord(messageData?.model);
    const rawModelId = readOptionalString(messageData?.modelID)
      || readOptionalString(messageData?.modelId)
      || readOptionalString(modelRecord?.modelID)
      || readOptionalString(modelRecord?.modelId);

    if (!rawModelId) {
      return null;
    }

    // Only the trial option is keyed by its account-scoped id in the picker,
    // so its readback re-attaches the scope for exact matching; individual-plan
    // sessions report bare ids that match the personal options directly.
    const providerId = readOptionalString(messageData?.providerID)
      || readOptionalString(messageData?.providerId)
      || readOptionalString(modelRecord?.providerID)
      || readOptionalString(modelRecord?.providerId);
    const modelId = providerId === ZCODE_START_PLAN_PROVIDER_ID
      ? `${ZCODE_START_PLAN_PROVIDER_ID}/${rawModelId}`
      : rawModelId;

    const variant = readOptionalString(messageData?.variant)
      || readOptionalString(modelRecord?.variant);

    return {
      modelId,
      variant: variant || undefined,
    };
  } catch {
    // Database missing or unreadable - model unknown
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * Reads the model a ZCode session last ran with from ZCode's own SQLite
 * store (most recent `message.data.modelID` per integration plan §3.2.5).
 *
 * Consumers: `ZCodeProviderModels.getCurrentActiveModel` (app session id
 * mapped to the provider id first) and the zcode runtime provider (which
 * already holds the provider session id and skips redundant `session/setModel`
 * calls when the requested model matches). Returns null when unknown.
 */
export function readZCodeSessionModelFromDb(providerSessionId: string): string | null {
  return readZCodeSessionModelInfoFromDb(providerSessionId)?.modelId ?? null;
}

/**
 * Fallback context window for a ZCode session whose model declares none in
 * the engine config (user-picked default, 2026-11-22).
 */
export const DEFAULT_ZCODE_CONTEXT_WINDOW = 200_000;

/**
 * Reads the context window one ZCode model declares: the engine config
 * record first (`provider.<id>.models.<key>.limit.context` — the same field
 * the model menu's description quotes), then the builtin `modelRules` row
 * (`properties.contextWindow`) so engine-added models have the right
 * denominator before the engine materializes their record.
 *
 * Consumer: zcode-sessions.provider's token usage readers, which need the
 * window as the usage denominator (composer panel bar, badge thresholds).
 * Returns null when neither source knows the model — callers fall back to
 * DEFAULT_ZCODE_CONTEXT_WINDOW.
 */
export function readZCodeModelContextLimit(modelId: string): number | null {
  try {
    const config = readObjectRecord(JSON.parse(
      fsSync.readFileSync(path.join(getZCodeStorageDir(), 'cli', 'config.json'), 'utf8')
    ));
    const providers = readObjectRecord(config?.provider);
    if (providers) {
      for (const providerConfig of Object.values(providers)) {
        const providerRecord = readObjectRecord(providerConfig);
        if (!providerRecord || providerRecord.enabled === false) continue;
        const models = readObjectRecord(providerRecord.models);
        const modelRecord = models ? readObjectRecord(models[modelId]) : null;
        if (!modelRecord) continue;
        const limits = readObjectRecord(modelRecord.limit);
        const context = Number(limits?.context);
        if (Number.isFinite(context) && context > 0) {
          return context;
        }
      }
    }
  } catch {
    // Missing or unreadable engine config: the builtin row may still know.
  }
  return readZCodeModelContextWindow(modelId);
}

/**
 * Resolves a model name/key string into ZCode's protocol model object
 * `{ providerId, modelId, variant? }`.
 *
 * Handles:
 * - Full model refs formatted as `providerId/modelId` (e.g. `builtin:bigmodel-coding-plan/GLM-5.3`)
 * - Bare model keys (e.g. `GLM-5.3`), by looking up the active/enabled provider from
 *   `cli/config.json` first, then the ZCode App native `v2/provider_config.json` personal
 *   providers, then defaulting
 * - Optional reasoning effort variant (e.g. `low`, `medium`, `high`, `max`)
 *
 * Consumer: `server/modules/providers/list/zcode/zcode-runtime.provider.ts`
 */
export function resolveZCodeModelRef(
  modelKey: string,
  reasoningLevel?: string,
): { providerId: string; modelId: string; options?: { reasoningLevel: string } } {
  const trimmed = modelKey.trim();
  const normalizedReasoningLevel = reasoningLevel && reasoningLevel !== 'default'
    ? reasoningLevel.trim().toLowerCase()
    : undefined;
  const slashIndex = trimmed.indexOf('/');
  const requestedProviderId = slashIndex >= 0 ? trimmed.slice(0, slashIndex).trim() : undefined;
  const requestedModelId = slashIndex >= 0 ? trimmed.slice(slashIndex + 1).trim() : trimmed;
  const hasIndividualKey = Boolean(readZCodeIndividualPlanAuthContext());
  const nativePersonalId = hasIndividualKey && getPersonalPlanModelIds().has(requestedModelId)
    ? ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID : null;

  if (nativePersonalId && (requestedProviderId === 'bigmodel-coding-plan'
      || requestedProviderId === 'builtin:bigmodel-coding-plan')) {
    return {
      providerId: nativePersonalId,
      modelId: requestedModelId,
      ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
    };
  }

  if (requestedProviderId === ZCODE_START_PLAN_PROVIDER_ID || requestedProviderId === ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID) {
    // Explicit account-plan selections route to their own quota: the trial
    // plan keeps its pinned option and the individual plan its personal quota.
    return {
      providerId: requestedProviderId,
      modelId: requestedModelId,
      ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
    };
  }

  if (requestedProviderId && !requestedProviderId.startsWith('builtin:') && !requestedProviderId.startsWith('account:')) {
    return {
      providerId: requestedProviderId,
      modelId: requestedModelId,
      ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
    };
  }

  // Look up enabled provider in config if possible. The app-server engine
  // resolves provider ids against its own cli/config.json, so that file is
  // consulted first; the App's v2 config only serves as a fallback because
  // its provider ids (builtin:*) may not exist in the engine's config.
  for (const configPath of [
    path.join(getZCodeStorageDir(), 'cli', 'config.json'),
    path.join(getZCodeStorageDir(), 'v2', 'config.json'),
  ]) {
    try {
      const content = fsSync.readFileSync(configPath, 'utf8');
      const config = readObjectRecord(JSON.parse(content));
      const providers = readObjectRecord(config?.provider);
      if (!providers) continue;
      for (const [providerId, providerConfig] of Object.entries(providers)) {
        if (providerId.startsWith('builtin:') || providerId.startsWith('account:')) continue;
        const providerRecord = readObjectRecord(providerConfig);
        if (providerRecord?.enabled === false) continue;
        const models = readObjectRecord(providerRecord?.models);
        if (models && requestedModelId in models) {
          return {
            providerId: isPersonalPlanProviderId(providerId) && nativePersonalId
              ? nativePersonalId : providerId,
            modelId: requestedModelId,
            ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
          };
        }
      }
      // Fallback: search even disabled providers if matching model
      for (const [providerId, providerConfig] of Object.entries(providers)) {
        if (providerId.startsWith('builtin:') || providerId.startsWith('account:')) continue;
        const providerRecord = readObjectRecord(providerConfig);
        const models = readObjectRecord(providerRecord?.models);
        if (models && requestedModelId in models) {
          return {
            providerId: isPersonalPlanProviderId(providerId) && nativePersonalId
              ? nativePersonalId : providerId,
            modelId: requestedModelId,
            ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
          };
        }
      }
    } catch {
      // Config read failed, try the next config source
    }
  }

  // Newer ZCode stores user-added providers in provider_config.json rather than
  // v2/config.json. Each provider rule lists every selectable model in
  // `modelOrder` (and the user's own additions in `personalModelIds`), which is
  // the only place a bare id like `deepseek-v4.1-flash` maps back to a provider.
  try {
    const personalPath = path.join(getZCodeStorageDir(), 'v2', 'provider_config.json');
    const personalConfig = readObjectRecord(JSON.parse(fsSync.readFileSync(personalPath, 'utf8')));
    const providerRules = readObjectRecord(personalConfig?.config)?.providerConfigRules;
    const rules = readObjectRecord(providerRules)?.providerRules;
    if (Array.isArray(rules)) {
      for (const rule of rules) {
        const ruleRecord = readObjectRecord(rule);
        const providerId = readOptionalString(ruleRecord?.providerId);
        const ruleConfig = readObjectRecord(ruleRecord?.config);
        if (!providerId || !ruleConfig) continue;

        const candidates = [
          ...(Array.isArray(ruleConfig.modelOrder) ? ruleConfig.modelOrder : []),
          ...(Array.isArray(ruleConfig.personalModelIds) ? ruleConfig.personalModelIds : []),
        ];
        if (candidates.some((candidate) => readOptionalString(candidate) === requestedModelId)) {
          return {
            providerId,
            modelId: requestedModelId,
            ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
          };
        }
      }
    }
  } catch {
    // Personal provider config missing or unreadable; fall through.
  }

  // Then the ZCode App's native personal providers. The cli lookup ran first
  // so bare-key precedence matches the merged catalog.
  for (const rule of readNativePersonalProviderRules()) {
    if (rule.modelIds.includes(requestedModelId)) {
      return {
        providerId: rule.providerId,
        modelId: requestedModelId,
        ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
      };
    }
  }

  return {
    providerId: requestedProviderId ?? nativePersonalId ?? 'builtin:bigmodel-coding-plan',
    modelId: requestedModelId,
    ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
  };
}

/**
 * Builds the per-turn model fields of ZCode's v4 `sendText` command payload.
 *
 * The provider identity and request authentication are resolved from the same
 * `cli/config.json` record so they cannot drift apart. The runtime consumes
 * this result directly as `sendText` payload fields; credentials only travel to
 * the local engine subprocess over stdio. Selections that belong to a ZCode App
 * native personal provider (`v2/provider_config.json`) carry only the selection:
 * the engine resolves their api key from the personal config handed to it at
 * spawn, so the credential is not copied into send params.
 *
 * Returns null when the local config cannot produce a complete, executable
 * selection (missing provider/model record, unsupported API kind, no base
 * URL, or no credentials). Both fields are optional in the engine's schema
 * (verified live against 0.16.9: a send without them runs on the engine's
 * own default model), so an incomplete local config degrades to a plain send
 * instead of blocking the turn.
 *
 * Consumer: zcode-runtime.provider.ts (per-turn model resolution).
 */
export function buildZCodeSendModelParams(
  modelKey: string,
  reasoningLevel?: string,
): {
  modelSelection: { providerId: string; modelId: string; options?: { reasoningLevel: string } };
  modelExecution: {
    selectionScope: 'execution';
    requestAuth?: { apiKey?: string; headers?: Record<string, string> };
  };
} | null {
  const explicitSelection = resolveZCodeModelRef(modelKey, reasoningLevel);

  if (explicitSelection.providerId === ZCODE_START_PLAN_PROVIDER_ID
      || explicitSelection.providerId === ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID) {
    const individual = explicitSelection.providerId === ZCODE_INDIVIDUAL_PLAN_PROVIDER_ID
      ? readZCodeIndividualPlanAuthContext() : null;
    if (individual?.kind === 'unavailable') throw new Error(individual.error);
    const apiKey = explicitSelection.providerId === ZCODE_START_PLAN_PROVIDER_ID
      ? readDecryptedZCodeJwtToken() : individual?.kind === 'legacy' ? individual.apiKey : null;
    if (!apiKey && individual?.kind !== 'project') {
      const plan = explicitSelection.providerId === ZCODE_START_PLAN_PROVIDER_ID ? 'start' : 'individual';
      throw new Error(`ZCode ${plan} plan credential is missing or ambiguous`);
    }
    const selectedReasoningLevel = explicitSelection.options?.reasoningLevel ?? 'max';
    return {
      modelSelection: {
        providerId: explicitSelection.providerId,
        modelId: explicitSelection.modelId,
        options: { reasoningLevel: selectedReasoningLevel },
      },
      modelExecution: {
        selectionScope: 'execution',
        // Modern account auth is resolved by the engine's runtime headers request.
        ...(apiKey ? { requestAuth: { apiKey } } : {}),
      },
    };
  }
  const configPath = path.join(getZCodeStorageDir(), 'cli', 'config.json');
  let providerRecord: Record<string, unknown> | null = null;
  let modelRecord: Record<string, unknown> | null = null;

  try {
    const config = readObjectRecord(JSON.parse(fsSync.readFileSync(configPath, 'utf8')));
    providerRecord = readObjectRecord(readObjectRecord(config?.provider)?.[explicitSelection.providerId]);
    modelRecord = readObjectRecord(readObjectRecord(providerRecord?.models)?.[explicitSelection.modelId]);
  } catch {
    // Treated as "not configured" below; the send may still route through
    // the native personal providers before degrading to the engine default.
  }
  if (!providerRecord || !modelRecord) {
    return buildNativePersonalSendParams(explicitSelection);
  }
  const providerOptions = readObjectRecord(providerRecord.options);
  const baseUrl = readOptionalString(providerOptions?.baseURL)
    ?? readOptionalString(providerOptions?.baseUrl);
  if (!resolveZCodeProviderApiType(providerRecord.kind) || !baseUrl) {
    return null;
  }

  const configuredDefault = readOptionalString(readObjectRecord(modelRecord?.reasoning)?.defaultLevel);
  // Same engine-spec fallback as the native path: a cli-config provider can
  // select a model whose builtin reasoning spec the local config knows
  // nothing about, and the engine rejects sends without a required level.
  const specValues = readZCodeModelReasoningValues(explicitSelection.modelId) ?? [];
  const selectedReasoningLevel = explicitSelection.options?.reasoningLevel
    ?? configuredDefault?.toLowerCase()
    ?? (specValues.length > 0 ? pickNativeReasoningDefault(specValues) : null);
  const modelSelection = {
    providerId: explicitSelection.providerId,
    modelId: explicitSelection.modelId,
    ...(selectedReasoningLevel ? { options: { reasoningLevel: selectedReasoningLevel } } : {}),
  };

  const apiKey = readOptionalString(providerOptions?.apiKey);
  const headers = readTrimmedStringRecord(providerOptions?.headers);
  const requestAuth = apiKey || headers
    ? {
        ...(apiKey ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
      }
    : undefined;
  if (!requestAuth) {
    return null;
  }

  return {
    modelSelection,
    modelExecution: {
      selectionScope: 'execution',
      requestAuth,
    },
  };
}

/**
 * ZCode models provider implementing model catalog and active model detection.
 */
export class ZCodeProviderModels implements IProviderModels {
  private cachedModels: ProviderModelsDefinition | null = null;

  /**
   * @param loadEngineCatalog - Catalog loader override. Production reads the
   *   engine's resolved catalog (see `primeZCodeModelCatalog`); tests inject a
   *   stub to stay hermetic and exercise the on-disk fallback.
   */
  constructor(
    private readonly loadEngineCatalog: () => Promise<ProviderModelsDefinition | null> = primeZCodeModelCatalog,
  ) {}

  /**
   * Returns the engine-resolved catalog, falling back to the on-disk ZCode
   * config and finally the static builtin definition.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (!this.cachedModels) {
      const engineCatalog = await this.loadEngineCatalog();
      this.cachedModels = engineCatalog ?? await readZCodeModelConfig();
    }
    return this.cachedModels;
  }

  /**
   * Returns the current active model for a session or default.
   *
   * The sessionId is the app-facing session id; it is mapped through the
   * sessions index to the ZCode-native session id before reading ZCode's
   * own database.
   */
  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (sessionId?.trim()) {
      const session = sessionsDb.getSessionById(sessionId);
      const providerSessionId = session ? readOptionalString(session.provider_session_id) : null;
      const modelInfo = providerSessionId
        ? readZCodeSessionModelInfoFromDb(providerSessionId)
        : null;

      if (modelInfo?.modelId) {
        if (session && !session.effort && modelInfo.variant) {
          sessionsDb.setSessionEffort(sessionId, modelInfo.variant);
        }
        return { model: modelInfo.modelId, effort: modelInfo.variant ?? null };
      }
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  /**
   * Clears the cached models.
   *
   * Consumer: `server/modules/providers/tests/zcode-models.test.ts`
   * (isolation between fixture config cases).
   */
  clearCache(): void {
    this.cachedModels = null;
  }
}

import fsSync from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
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

import { getZCodeDatabasePath, getZCodeStorageDir } from './zcode-data-root.js';
import { resolveZCodeProviderApiType } from './zcode-provider-config.js';

/**
 * ZCode builtin models definition as fallback when config read fails.
 * Based on integration plan §3.2.5 and spike findings (GLM-5.3 with 1M context, 128K output).
 */
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
  DEFAULT: 'GLM-5.3',
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: 'Faster, less detailed reasoning',
  high: 'Balanced reasoning for most tasks',
  max: 'Maximum reasoning for complex tasks',
};

/**
 * Reads ZCode's user-facing provider config to extract model definitions.
 * 0.16.9 stores the active catalog in `cli/config.json`; the older v2 path is
 * retained as a fallback for installations that have not rewritten it yet.
 */
const readZCodeModelConfig = async (): Promise<ProviderModelsDefinition> => {
  try {
    let config: Record<string, unknown> | null = null;
    for (const configPath of [
      path.join(getZCodeStorageDir(), 'cli', 'config.json'),
      path.join(getZCodeStorageDir(), 'v2', 'config.json'),
    ]) {
      try {
        config = readObjectRecord(JSON.parse(await readFile(configPath, 'utf8')));
        if (readObjectRecord(config?.provider)) break;
      } catch {
        // Try the next supported config location.
      }
    }

    if (!config) {
      return ZCODE_BUILTIN_MODELS;
    }

    const providers = readObjectRecord(config.provider);
    if (!providers) {
      return ZCODE_BUILTIN_MODELS;
    }

    const modelOptions: ProviderModelOption[] = [];
    const seenModelKeys = new Set<string>();

    for (const providerConfig of Object.values(providers)) {
      const providerRecord = readObjectRecord(providerConfig);
      // Skip explicitly disabled providers
      if (providerRecord?.enabled === false) continue;

      const models = readObjectRecord(providerRecord?.models);
      if (!models) continue;

      for (const [modelKey, modelConfig] of Object.entries(models)) {
        if (seenModelKeys.has(modelKey)) continue;

        const modelRecord = readObjectRecord(modelConfig);
        if (!modelRecord) continue;

        seenModelKeys.add(modelKey);

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
            .sort();
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

        modelOptions.push({
          value: modelKey,
          label: modelKey,
          description: readOptionalString(modelRecord.description) || description,
          effort: hasReasoning ? effort : undefined,
        });
      }
    }

    if (modelOptions.length === 0) {
      return ZCODE_BUILTIN_MODELS;
    }

    return {
      OPTIONS: modelOptions,
      DEFAULT: modelOptions[0]?.value ?? 'GLM-5.3',
    };
  } catch {
    // Config read failed, return builtin models
    return ZCODE_BUILTIN_MODELS;
  }
};

/**
 * Reads the model a ZCode session last ran with from ZCode's own SQLite
 * store (most recent `message.data.modelID` per integration plan §3.2.5).
 *
 * Consumer: `ZCodeProviderModels.getCurrentActiveModel` in this file (app
 * session id mapped to the provider id first); also exercised directly by
 * `server/modules/providers/tests/zcode-models.test.ts`. Returns null when
 * unknown.
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
    const modelId = readOptionalString(messageData?.modelID)
      || readOptionalString(modelRecord?.modelID)
      || readOptionalString(modelRecord?.modelId);

    if (!modelId) {
      return null;
    }

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
 * Resolves a model name/key string into ZCode 0.16.9's model selection.
 *
 * Handles:
 * - Full model refs formatted as `providerId/modelId` (e.g. `builtin:bigmodel-coding-plan/GLM-5.3`)
 * - Bare model keys (e.g. `GLM-5.3`), by looking up the active/enabled provider from config or defaulting
 * - Optional reasoning effort in `options.reasoningLevel`
 *
 * Consumer: `buildZCodeSendModelParams` in this file, plus direct ref-parsing
 * coverage in `server/modules/providers/tests/zcode-models.test.ts`.
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
            providerId,
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
            providerId,
            modelId: requestedModelId,
            ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
          };
        }
      }
    } catch {
      // Config read failed, try the next config source
    }
  }

  return {
    providerId: requestedProviderId ?? 'builtin:bigmodel-coding-plan',
    modelId: requestedModelId,
    ...(normalizedReasoningLevel ? { options: { reasoningLevel: normalizedReasoningLevel } } : {}),
  };
}

/**
 * Builds the per-turn model fields accepted by ZCode app-server 0.16.9's
 * `session/send`.
 *
 * The provider identity and request authentication are resolved from the same
 * `cli/config.json` record so they cannot drift apart. The runtime consumes
 * this result directly as `session/send` params; credentials only travel to
 * the local engine subprocess over stdio.
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
  const configPath = path.join(getZCodeStorageDir(), 'cli', 'config.json');
  let providerRecord: Record<string, unknown> | null = null;
  let modelRecord: Record<string, unknown> | null = null;

  try {
    const config = readObjectRecord(JSON.parse(fsSync.readFileSync(configPath, 'utf8')));
    providerRecord = readObjectRecord(readObjectRecord(config?.provider)?.[explicitSelection.providerId]);
    modelRecord = readObjectRecord(readObjectRecord(providerRecord?.models)?.[explicitSelection.modelId]);
  } catch {
    // Treated as "not configured" below; the send degrades to the engine default.
  }
  if (!providerRecord || !modelRecord) {
    return null;
  }
  const providerOptions = readObjectRecord(providerRecord.options);
  const baseUrl = readOptionalString(providerOptions?.baseURL)
    ?? readOptionalString(providerOptions?.baseUrl);
  if (!resolveZCodeProviderApiType(providerRecord.kind) || !baseUrl) {
    return null;
  }

  const configuredDefault = readOptionalString(readObjectRecord(modelRecord?.reasoning)?.defaultLevel);
  const selectedReasoningLevel = explicitSelection.options?.reasoningLevel
    ?? configuredDefault?.toLowerCase();
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
   * Returns supported models from ZCode config or builtin fallback.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (!this.cachedModels) {
      this.cachedModels = await readZCodeModelConfig();
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
        return { model: modelInfo.modelId };
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

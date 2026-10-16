import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderModelOption,
} from '@/shared/types.js';
import {
  AppError,
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { codexAppServerTransport } from './codex-app-server.client.js';

const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const invalidCatalog = () => new AppError('Codex returned an invalid or empty model catalog.', {
  code: 'CODEX_MODEL_CATALOG_INVALID', statusCode: 502,
});

/** Reads only complete model entries so a broken refresh cannot replace a working catalog. */
function parseModel(value: unknown): ProviderModelOption | null {
  const entry = readObjectRecord(value);
  if (!entry) throw invalidCatalog();
  if (entry.hidden === true) return null;
  const modelId = readOptionalString(entry.model);
  const label = readOptionalString(entry.displayName);
  if (!modelId || !label || !Array.isArray(entry.supportedReasoningEfforts)) throw invalidCatalog();
  const values = entry.supportedReasoningEfforts.map((raw) => {
    const effort = readObjectRecord(raw);
    const value = readOptionalString(effort?.reasoningEffort);
    if (!value) throw invalidCatalog();
    const description = readOptionalString(effort?.description);
    return { value, ...(description ? { description } : {}) };
  });
  const defaultEffort = readOptionalString(entry.defaultReasoningEffort);
  if (defaultEffort && !values.some((item) => item.value === defaultEffort)) throw invalidCatalog();
  const description = readOptionalString(entry.description);
  return {
    value: modelId, label,
    ...(description ? { description } : {}),
    ...(values.length ? { effort: { ...(defaultEffort ? { default: defaultEffort } : {}), values } } : {}),
  };
}

/** Provider registry consumer: discovers models from the same bundled CLI used for conversations. */
export class CodexProviderModels implements IProviderModels {
  private cachedModels: ProviderModelsDefinition | null = null;
  private cacheExpiry = 0;
  private pending: Promise<ProviderModelsDefinition> | null = null;

  private async fetchModels(): Promise<ProviderModelsDefinition> {
    const connection = await codexAppServerTransport.open();
    try {
      const options = new Map<string, ProviderModelOption>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let defaultModel: string | undefined;
      do {
        const page = readObjectRecord(await connection.call('model/list', {
          limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
        }));
        if (!page || !Array.isArray(page.data)) throw invalidCatalog();
        for (const raw of page.data) {
          const option = parseModel(raw);
          if (!option) continue;
          options.set(option.value, option);
          if (readObjectRecord(raw)?.isDefault === true) defaultModel = option.value;
        }
        if (page.nextCursor != null && !readOptionalString(page.nextCursor)) throw invalidCatalog();
        cursor = readOptionalString(page.nextCursor) ?? undefined;
        if (cursor && cursors.has(cursor)) throw invalidCatalog();
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const first = options.values().next().value;
      if (!first) throw invalidCatalog();
      return { OPTIONS: [...options.values()], DEFAULT: defaultModel ?? first.value };
    } finally {
      connection.close();
    }
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const now = Date.now();
    if (this.cachedModels && now < this.cacheExpiry) return this.cachedModels;
    if (this.pending) return this.pending;
    this.pending = this.fetchModels().then((models) => {
      this.cachedModels = models;
      this.cacheExpiry = Date.now() + 5 * 60_000;
      return models;
    }).catch((error: unknown) => {
      console.error('[Codex] Model catalog refresh failed:', error);
      if (!this.cachedModels) throw error;
      // Briefly back off after failure; never replace discovered models with static guesses.
      this.cacheExpiry = Date.now() + 10_000;
      return this.cachedModels;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    let model: string | null = null;
    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      model = readOptionalString(parsed?.model) ?? null;
    } catch {
      // Missing or unreadable config uses the discovered default below.
    }
    return model ? { model } : buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}

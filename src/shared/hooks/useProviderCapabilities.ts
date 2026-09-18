import { useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import type { LLMProvider } from '@/shared/types';

/**
 * The backend-owned answer to "what can this provider actually do", as served
 * by `GET /api/providers/capabilities` (derived from the provider registry +
 * static catalog in `provider-capabilities.service.ts`).
 *
 * This hook is the app's single fetch point for that matrix: one module-level
 * cache plus in-flight dedup, so the several consumers (composer permission
 * modes, sidebar fork affordances) share one request instead of each mounting
 * its own. Fields the backend may not send (older servers) stay optional;
 * consumers fall back to `PROVIDER_FALLBACK_CATALOG` while `capabilities` is
 * null.
 */
export type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsFiles: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsTokenUsage: boolean;
  supportsEffort?: boolean;
  supportsMessageEditing?: boolean;
  supportsSessionForking?: boolean;
  /** Whether replacing an already-sent message also reverts the files the agent changed. */
  editRevertsFiles?: boolean;
  /** Whether the provider runtime can compact a session's context on demand (`/compact`). */
  supportsCompaction?: boolean;
};

let cachedCapabilities: Partial<Record<LLMProvider, ProviderCapabilities>> | null = null;
let inFlightRequest: Promise<Partial<Record<LLMProvider, ProviderCapabilities>> | null> | null = null;

/**
 * Delays before re-asking for the matrix after a failed attempt. This request
 * gates provider-only affordances (notably `/compact` in the slash menu), and a
 * page that mounts inside a server-restart window would otherwise lose them
 * until something remounts the hook — the same reason the model catalog retries.
 * Exhausting the delays leaves the map null and the retry to the next mount.
 */
const CAPABILITIES_RETRY_DELAYS_MS = [2_000, 8_000];

/** One attempt at the capability matrix; null on any failure (HTTP or transport). */
async function fetchCapabilities(): Promise<Partial<Record<LLMProvider, ProviderCapabilities>> | null> {
  try {
    const response = await api.providers.capabilities();
    const body = (await response.json()) as { success?: boolean; data?: { providers?: ProviderCapabilities[] } };
    if (!body.success || !Array.isArray(body.data?.providers)) {
      return null;
    }
    const byProvider: Partial<Record<LLMProvider, ProviderCapabilities>> = {};
    for (const row of body.data.providers) {
      byProvider[row.provider] = row;
    }
    return byProvider;
  } catch (error) {
    console.error('Error loading provider capabilities:', error);
    return null;
  }
}

/**
 * Resolves the capability map, or null when every attempt failed. A failure is
 * deliberately not cached — a transient failure should not disable
 * affordances for the rest of the session — so the next mount retries.
 */
function loadCapabilities(): Promise<Partial<Record<LLMProvider, ProviderCapabilities>> | null> {
  if (cachedCapabilities) {
    return Promise.resolve(cachedCapabilities);
  }
  if (inFlightRequest) {
    return inFlightRequest;
  }

  inFlightRequest = (async () => {
    try {
      for (let attempt = 0; ; attempt += 1) {
        const capabilities = await fetchCapabilities();
        if (capabilities) {
          cachedCapabilities = capabilities;
          return capabilities;
        }

        const retryDelay = CAPABILITIES_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined) {
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    } finally {
      inFlightRequest = null;
    }
  })();

  return inFlightRequest;
}

type ProviderCapabilitiesState = {
  /** Null while loading or after a failed request (consumers use their fallback). */
  capabilities: Partial<Record<LLMProvider, ProviderCapabilities>> | null;
  /** Whether the request has settled at least once in this mount. */
  loaded: boolean;
};

/**
 * Reads the shared capability matrix. Consume `capabilities` and treat null
 * as "use the fallback catalog"; `loaded` distinguishes loading from failure.
 */
export function useProviderCapabilitiesMap(): ProviderCapabilitiesState {
  const [state, setState] = useState<ProviderCapabilitiesState>(() => (
    cachedCapabilities
      ? { capabilities: cachedCapabilities, loaded: true }
      : { capabilities: null, loaded: false }
  ));

  useEffect(() => {
    if (state.loaded) {
      return;
    }
    let cancelled = false;
    void loadCapabilities().then((capabilities) => {
      if (cancelled) return;
      setState({ capabilities, loaded: true });
    });
    return () => {
      cancelled = true;
    };
    // The load happens once per mount; `state.loaded` is read at effect time
    // on purpose so a settled failure is not retried within the same mount.
    // eslint-disable-next-line react/exhaustive-deps
  }, []);

  return state;
}

const EMPTY_FORKABLE_PROVIDERS: Set<LLMProvider> = new Set();

/**
 * Reports which providers can branch a session's transcript.
 *
 * Empty until the matrix loads, so an affordance is never offered and then
 * withdrawn.
 */
export function useSessionForkingProviders(): Set<LLMProvider> {
  const { capabilities, loaded } = useProviderCapabilitiesMap();

  return useMemo(() => {
    if (!loaded || !capabilities) {
      return EMPTY_FORKABLE_PROVIDERS;
    }
    const forkable = new Set<LLMProvider>();
    for (const row of Object.values(capabilities)) {
      if (row?.supportsSessionForking) {
        forkable.add(row.provider);
      }
    }
    return forkable;
  }, [loaded, capabilities]);
}

import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderQuotaData,
  ProviderQuotaResetConsumeInput,
  ProviderQuotaResetConsumeResult,
  ProviderTokenUsageResult,
} from '@/shared/types.js';
export { summarizeClaudeTokenUsage } from './claude-usage.js';
import { AppError } from '@/shared/utils.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  resolveProvider: (provider: string) => Pick<IProvider, 'sessions' | 'auth'>;
  isProviderSessionSuperseded: (providerSessionId: string, provider: string) => boolean;
};

const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  isProviderSessionSuperseded: (providerSessionId, provider) => {
    try {
      return sessionsDb.isProviderSessionSuperseded(providerSessionId, provider);
    } catch {
      // No database context (unit tests, early startup): treat as live so the
      // provider facet still answers.
      return false;
    }
  },
};

/**
 * Builds the explicit "this provider cannot report usage" answer for session
 * rows whose provider adapter does not implement the optional
 * `IProviderSessions.getTokenUsage` facet (Cursor today).
 */
function createUnsupportedTokenUsage(provider: string): ProviderTokenUsageResult {
  return {
    used: 0,
    total: 0,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
    unsupported: true,
    message: `Token usage tracking not available for ${provider} sessions`,
  };
}

/**
 * Creates the provider token-usage service used by the provider routes.
 *
 * Pure dispatcher: it resolves the app-facing session row, maps it to the
 * provider-native session identity, and hands the read to the owning
 * provider's sessions/auth facet. Every provider-specific storage detail
 * (transcript layouts, SQLite schemas, context windows) lives in the provider
 * adapters; the provider test suite supplies isolated session/registry
 * dependencies so dispatch can be exercised without touching real data.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  /**
   * Providers with a reset-card spend currently in flight.
   *
   * Spending a card is irreversible and each attempt mints a fresh
   * idempotency key, so protocol-level dedup cannot protect against two
   * overlapping requests (double-open tabs, double clicks through to the
   * backend) reading the same available card and spending it twice. One
   * spend per provider at a time, enforced at the dispatch point every
   * caller goes through. Per-service-instance state: the production singleton
   * gates the whole process, test instances stay isolated.
   */
  const inFlightQuotaResets = new Set<string>();

  return {
    /**
     * Resolves the provider adapter from one app-facing session id and
     * returns the latest usage snapshot for that provider.
     */
    async getSessionTokenUsage(sessionId: string): Promise<ProviderTokenUsageResult> {
      const session = dependencies.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      // The fallback covers rows whose provider id was never recorded, and for
      // a session discovered from disk the app id *is* its provider id. That
      // stops being true the moment an edit rewinds the conversation off a
      // thread: until the replacement run announces its own id, the fallback
      // would resolve the retired transcript and report the discarded
      // conversation's usage against an empty one.
      if (
        !session.provider_session_id
        && dependencies.isProviderSessionSuperseded(sessionId, session.provider)
      ) {
        return {
          used: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
        };
      }

      const provider = dependencies.resolveProvider(session.provider);
      if (!provider.sessions.getTokenUsage) {
        return createUnsupportedTokenUsage(session.provider);
      }

      return provider.sessions.getTokenUsage({
        appSessionId: sessionId,
        nativeSessionId: session.provider_session_id || sessionId,
        jsonlPath: session.jsonl_path ?? null,
        projectPath: session.project_path ?? null,
      });
    },

    /**
     * Retrieves account-level quota status (5-hour and weekly limits) for
     * providers that expose the optional auth facet method, null otherwise.
     */
    async getProviderQuota(
      provider: string,
      options?: { forceRefresh?: boolean },
    ): Promise<ProviderQuotaData | null> {
      return dependencies.resolveProvider(provider).auth.getQuota?.(options) ?? null;
    },

    /**
     * Spends one of the provider account's quota-reset cards through the
     * optional auth facet. Throws a typed 400 when the provider cannot spend
     * cards at all (the UI gates the action on `supportsQuotaReset`, so this
     * only fires for hand-crafted requests).
     */
    async consumeProviderQuotaReset(
      provider: string,
      input: ProviderQuotaResetConsumeInput,
    ): Promise<ProviderQuotaResetConsumeResult> {
      const consume = dependencies.resolveProvider(provider).auth.consumeQuotaReset;
      if (!consume) {
        throw new AppError(`Provider "${provider}" does not support quota reset cards.`, {
          code: 'QUOTA_RESET_UNSUPPORTED',
          statusCode: 400,
        });
      }

      if (inFlightQuotaResets.has(provider)) {
        throw new AppError(
          `A quota reset for "${provider}" is already in progress; wait for it to finish.`,
          { code: 'QUOTA_RESET_IN_PROGRESS', statusCode: 409 },
        );
      }
      inFlightQuotaResets.add(provider);
      try {
        return await consume(input);
      } finally {
        inFlightQuotaResets.delete(provider);
      }
    },
  };
}

/**
 * Used by the provider routes to serve token usage from only an app session id.
 */
export const providerTokenUsageService = createProviderTokenUsageService();


/**
 * OpenCode Runtime Provider
 *
 * Thin orchestration over the opencode module's building blocks: the
 * service supervisor (`opencode-service.ts`), the event stream
 * (`opencode-event-stream.ts`), the interaction bridge
 * (`opencode-interaction-bridge.ts`), the run registry
 * (`opencode-run-registry.ts`), session settings
 * (`opencode-session-settings.ts`) and prompt attachments
 * (`opencode-prompt-attachments.ts`).
 *
 * One `run()` = ensure the service → create/reuse the provider session
 * anchored to the project directory → apply the permission mode → switch
 * the model (variant = reasoning effort) → POST the prompt → forward
 * translated events until an execution terminal. `abort()` POSTs interrupt
 * and retracts pending cards; the gateway owns the aborted `complete`, so
 * none is sent here. The `permissions` facet answers permission/question
 * cards and replays them after a reload.
 *
 * @module opencode-runtime.provider
 */

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  generateMessageId,
  readOptionalString,
  resolveModelEffort,
} from '@/shared/utils.js';

import {
  OpenCodeApiClient,
  OpenCodeApiError,
  parseOpenCodeModelRef,
  type OpenCodeServiceEndpoint,
} from './opencode-api.client.js';
import { OpenCodeEventStream } from './opencode-event-stream.js';
import { OpenCodeInteractionBridge } from './opencode-interaction-bridge.js';
import { buildOpenCodePromptFiles, buildOpenCodePromptText } from './opencode-prompt-attachments.js';
import { OpenCodeRunRegistry, toOpenCodeTokenBudget } from './opencode-run-registry.js';
import { OpenCodeServiceError, OpenCodeServiceSupervisor } from './opencode-service.js';
import {
  OpenCodeSessionSettingsApplier,
  resolveOpenCodeSessionSettings,
} from './opencode-session-settings.js';

export { resolveOpenCodeSessionSettings } from './opencode-session-settings.js';

const PROVIDER = 'opencode' as const;

type RuntimeDependencies = {
  supervisor?: Pick<OpenCodeServiceSupervisor, 'ensureEndpoint' | 'onExit' | 'currentEndpoint'>;
  createClient?: (endpoint: OpenCodeServiceEndpoint) => OpenCodeApiClient;
  /** Grace period before an interrupt is assumed to have landed; default 5s. */
  abortSettleGraceMs?: number;
};

/**
 * Builds the runtime wired to the production supervisor and event stream.
 *
 * Consumers: `opencode.provider.ts` (module-level singleton via
 * `opencodeRuntime`) and the runtime tests (own supervisor + fake service).
 */
export function createOpenCodeRuntime(dependencies: RuntimeDependencies = {}): IProviderRuntime {
  const supervisor = dependencies.supervisor ?? new OpenCodeServiceSupervisor();
  const createClient = dependencies.createClient ?? ((endpoint) => new OpenCodeApiClient(endpoint));
  const abortSettleGraceMs = dependencies.abortSettleGraceMs ?? 5_000;

  // Reconnects only boot the service while a run is in flight (runs create
  // their registry entry before awaiting the stream); with nobody chatting a
  // broken engine must not be resurrected forever.
  const eventStream = new OpenCodeEventStream(async () => {
    const endpoint = supervisor.currentEndpoint();
    if (endpoint) {
      return endpoint;
    }
    if (runs.all().length === 0) {
      throw new Error('OpenCode service is not running');
    }
    return supervisor.ensureEndpoint();
  });
  let client: OpenCodeApiClient | null = null;

  const bridge = new OpenCodeInteractionBridge({ getClient: () => client });
  const runs = new OpenCodeRunRegistry();
  const settings = new OpenCodeSessionSettingsApplier();

  eventStream.subscribe((event) => {
    bridge.handleEvent(event);
    runs.dispatch(event);
  });
  eventStream.onReconnect(() => {
    void runs.reconcile({ getSession: (sessionId) => client?.getSession(sessionId)
      ?? Promise.reject(new OpenCodeApiError('GET', '/api/session', 503, 'OpenCode service is not running')) });
  });
  supervisor.onExit(() => {
    settings.reset();
    runs.settleAll({ outcome: 'lost', error: 'The OpenCode service exited while the run was in progress.' });
  });

  const sendTokenBudget = async (
    appSessionId: string,
    providerSessionId: string,
    writer: ProviderRuntimeWriter,
  ): Promise<void> => {
    if (!client) {
      return;
    }
    try {
      const snapshot = await client.getSession(providerSessionId);
      const budget = snapshot.tokens ? toOpenCodeTokenBudget(snapshot.tokens) : null;
      if (budget) {
        writer.send(createNormalizedMessage({
          id: generateMessageId(PROVIDER),
          sessionId: appSessionId,
          provider: PROVIDER,
          kind: 'status',
          text: 'token_budget',
          tokenBudget: budget,
        }));
      }
    } catch (error) {
      console.warn('[OpenCode] failed to read the token budget:', error);
    }
  };

  const run = async (
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<void> => {
    const appSessionId = readOptionalString(options.sessionId);
    if (!appSessionId) {
      throw new Error('OpenCode runtime requires the app session id');
    }
    const workingDir = readOptionalString(options.cwd) ?? readOptionalString(options.projectPath) ?? process.cwd();
    const sessionSummary = readOptionalString(options.sessionSummary);
    const userId = writer.userId === undefined || writer.userId === null ? null : String(writer.userId);

    const describeError = (error: unknown): string => (
      error instanceof OpenCodeServiceError || error instanceof OpenCodeApiError
        ? error.message
        : error instanceof Error ? error.message : String(error)
    );
    const failRun = (message: string): never => {
      writer.send(createNormalizedMessage({
        id: generateMessageId(PROVIDER),
        sessionId: appSessionId,
        provider: PROVIDER,
        kind: 'error',
        content: message,
        isError: true,
      }));
      writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: appSessionId, exitCode: 1 }));
      notifyRunFailed({ userId, provider: PROVIDER, sessionId: appSessionId, sessionName: sessionSummary, error: message });
      throw new Error(message);
    };

    let endpoint: OpenCodeServiceEndpoint;
    try {
      endpoint = await supervisor.ensureEndpoint();
    } catch (error) {
      return failRun(describeError(error));
    }
    eventStream.start();
    const activeClient = createClient(endpoint);
    client = activeClient;

    let providerSessionId = context.resolveProviderSessionId(appSessionId);
    try {
      if (!providerSessionId) {
        const created = await activeClient.createSession({ directory: workingDir, title: sessionSummary });
        providerSessionId = created.id;
        // The writer swallows session_created and persists the provider id.
        writer.setSessionId?.(providerSessionId);
        writer.send(createNormalizedMessage({
          kind: 'session_created',
          provider: PROVIDER,
          sessionId: appSessionId,
          newSessionId: providerSessionId,
        }));
      }
      await settings.apply(activeClient, providerSessionId, resolveOpenCodeSessionSettings(options.permissionMode));

      const resolvedModel = await context.resolveResumeModel(appSessionId, readOptionalString(options.model));
      if (resolvedModel) {
        let effortModels = null;
        try {
          effortModels = await context.getProviderModels();
        } catch (error) {
          console.warn('[OpenCode] unable to load provider models for effort validation:', error);
        }
        const effort = resolveModelEffort(resolvedModel, options.effort, effortModels);
        const modelRef = parseOpenCodeModelRef(resolvedModel, effort);
        if (modelRef) {
          await settings.applyModel(activeClient, providerSessionId, modelRef);
        } else {
          console.warn(`[OpenCode] cannot parse model reference "${resolvedModel}"; the session keeps its previous model`);
        }
      }
    } catch (error) {
      return failRun(describeError(error));
    }

    const text = buildOpenCodePromptText(command, options);
    const files = await buildOpenCodePromptFiles(options, workingDir);
    if (!text.trim() && files.length === 0) {
      return failRun('Nothing to send: the message is empty.');
    }

    const activeRun = runs.create(appSessionId, providerSessionId, writer);
    bridge.attach({
      appSessionId,
      providerSessionId,
      writer,
      resolveToolCall: (callId) => activeRun.translator.getToolCall(callId),
    });

    // The feed must be live before the prompt: events emitted between the
    // prompt POST and the stream connecting would be lost for good.
    await eventStream.connected();

    try {
      await activeClient.prompt(providerSessionId, { text, files });
      activeRun.promptAccepted = true;
    } catch (error) {
      runs.release(activeRun);
      bridge.cancelSession(appSessionId, 'The message was rejected by the OpenCode service.');
      bridge.detach(providerSessionId);
      return failRun(`OpenCode rejected the message: ${describeError(error)}`);
    }

    const settlement = await activeRun.settled;
    runs.release(activeRun);
    // Retract any cards still pending, then drop the run's writer from the
    // bridge so finished sessions do not pin memory forever.
    bridge.cancelSession(appSessionId, 'The run ended with cards still pending.');
    bridge.detach(providerSessionId);

    await sendTokenBudget(appSessionId, providerSessionId, writer);

    if (activeRun.aborted) {
      // The user stopped this run: the gateway's abort handler already
      // emitted the aborted complete, and a racing terminal event must not
      // paint a second, contradictory outcome over it.
      return;
    }
    if (settlement.outcome === 'succeeded') {
      writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: appSessionId, exitCode: 0 }));
      notifyRunStopped({
        userId, provider: PROVIDER, sessionId: appSessionId, sessionName: sessionSummary, stopReason: 'completed',
      });
      return;
    }
    if (settlement.outcome === 'interrupted') {
      writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: appSessionId, exitCode: 0, aborted: true }));
      notifyRunStopped({
        userId, provider: PROVIDER, sessionId: appSessionId, sessionName: sessionSummary, stopReason: 'aborted',
      });
      return;
    }
    writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: appSessionId, exitCode: 1 }));
    notifyRunFailed({
      userId, provider: PROVIDER, sessionId: appSessionId, sessionName: sessionSummary, error: settlement.error,
    });
    throw new Error(settlement.error);
  };

  const abort = (sessionId: string): boolean => {
    const activeRun = runs.get(sessionId);
    if (!activeRun) {
      return false;
    }
    if (!activeRun.aborted) {
      activeRun.aborted = true;
      bridge.cancelSession(activeRun.appSessionId, 'The run was stopped.');
      if (!client) {
        activeRun.settle({ outcome: 'interrupted', reason: 'user' });
      } else {
        client.interrupt(activeRun.providerSessionId)
          .then((interrupted) => {
            // `false` = nothing was running; the terminal already fired
            // (likely during a stream gap) and must not be waited for.
            if (!interrupted) {
              activeRun.settle({ outcome: 'interrupted', reason: 'user' });
            }
          })
          .catch((error) => {
            console.warn('[OpenCode] interrupt request failed:', error);
            activeRun.settle({ outcome: 'interrupted', reason: 'user' });
          });
      }
      // Safety net: a dropped `execution.interrupted` event must not wedge the
      // session in "processing"; the settlement contract ignores later calls.
      const timer = setTimeout(() => {
        activeRun.settle({ outcome: 'interrupted', reason: 'user' });
      }, abortSettleGraceMs);
      timer.unref?.();
    }
    return true;
  };

  return {
    run,
    abort,
    permissions: {
      resolve(requestId: string, decision: ProviderPermissionDecision): void {
        bridge.resolve(requestId, decision);
      },
      listPending(sessionId: string): unknown[] {
        return bridge.listPending(sessionId);
      },
    },
  };
}

/**
 * The production singleton: one service supervisor, event stream and run
 * registry per cloudcli process, shared by every opencode chat run.
 *
 * Consumer: `opencode.provider.ts`.
 */
export const opencodeRuntime: IProviderRuntime = createOpenCodeRuntime();

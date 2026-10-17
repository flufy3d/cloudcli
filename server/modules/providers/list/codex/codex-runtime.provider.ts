/**
 * Codex conversation runtime
 * ==========================
 *
 * Runs one Codex turn over `codex app-server` and forwards what it reports to
 * the client.
 *
 * ## Why app-server and not `@openai/codex-sdk`
 *
 * The SDK wraps `codex exec`, whose JSON stream numbers items per process:
 * the first item of every turn is `item_0`, and a resumed thread starts the
 * count over. The rollout the same turn writes records Codex's real item ids
 * (`msg_…`, `rs_…`, `exec-<uuid>`), so the live frame and the row a later
 * history read returns had no id in common and the client rendered each reply
 * twice. `app-server` streams the same items *with those ids*, which is what
 * makes one row one row. It also reports the real turn id, streams assistant
 * text as it is written, and is the transport `thread/fork` already needed.
 *
 * ## Usage
 *
 * - codexRuntime.run(command, options, writer, context) — execute a streamed prompt
 * - codexRuntime.abort(sessionId) — cancel an active session
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  codexAppServer,
  codexAppServerTransport,
  type CodexAppServerConnection,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import {
  codexThreadItemToRows,
  readCodexAppServerItem,
  readCodexCommandLine,
} from '@/modules/providers/list/codex/codex-thread-items.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors,
  createCompleteMessage,
  createNormalizedMessage,
  resolveCodexExecutionPolicy,
  resolveModelEffort,
} from '@/shared/index.js';
import type {
  AnyRecord,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/index.js';
import type { BackgroundTaskSummary } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

const TASK_MCP_NAME = 'cloudcli_task_continuations';
const TASK_API_URL_ENV = 'CLOUDCLI_TASK_API_URL';
const TASK_API_KEY_ENV = 'CLOUDCLI_TASK_API_KEY';
const TASK_RUN_CONTEXT_ENV = 'CLOUDCLI_TASK_RUN_CONTEXT';

function getTaskMcpCommand(): { command: string; args: string[] } {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const compiledEntrypoint = path.resolve(moduleDirectory, '../../../task-continuations/cli/task-continuations-mcp.js');
  if (existsSync(compiledEntrypoint)) {
    return { command: process.execPath, args: [compiledEntrypoint] };
  }

  const repositoryRoot = path.resolve(moduleDirectory, '../../../../../');
  const sourceEntrypoint = path.join(repositoryRoot, 'server', 'modules', 'task-continuations', 'cli', 'task-continuations-mcp.ts');
  return {
    command: path.join(repositoryRoot, 'node_modules', '.bin', 'tsx'),
    args: ['--tsconfig', path.join(repositoryRoot, 'server', 'tsconfig.json'), sourceEntrypoint],
  };
}

function getTaskMcpRuntimeOptions(input: {
  token: string;
}): { config: Record<string, unknown>; env: NodeJS.ProcessEnv } {
  const apiUrl = process.env.CLOUDCLI_API_URL
    || `http://127.0.0.1:${process.env.SERVER_PORT || process.env.PORT || '3001'}`;
  return {
    config: {
      [`mcp_servers.${TASK_MCP_NAME}`]: {
        ...getTaskMcpCommand(),
        env_vars: [TASK_API_URL_ENV, TASK_API_KEY_ENV, TASK_RUN_CONTEXT_ENV],
      },
    },
    env: {
      [TASK_API_URL_ENV]: apiUrl.replace(/\/$/, ''),
      [TASK_API_KEY_ENV]: process.env.API_KEY ?? '',
      [TASK_RUN_CONTEXT_ENV]: input.token,
    },
  };
}

async function readEffectiveShellEnvironmentExcludes(
  connection: CodexAppServerConnection,
  cwd: string,
): Promise<string[]> {
  const response = readObjectRecord(await connection.call('config/read', { includeLayers: false, cwd }));
  const config = readObjectRecord(response?.config);
  const policy = readObjectRecord(config?.shell_environment_policy);
  return Array.isArray(policy?.exclude)
    ? policy.exclude.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

type ActiveCodexSession = {
  connection: CodexAppServerConnection;
  /** Set once the server reports the turn; `turn/interrupt` needs it. */
  threadId: string | null;
  turnId: string | null;
  status: 'running' | 'aborted' | 'completed';
  startedAt: string;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();

/**
 * Collab agents still running, keyed by app session id, then by the collab
 * item id that spawned the agent.
 *
 * Unlike Claude — where one CLI process owns a turn and dies with it — the
 * codex engine outlives turns, so an agent spawned mid-turn keeps working
 * after the turn's `result`. This map is what the running-sessions poll reads
 * (through `listBackgroundWork`) so the composer's background-work strip can
 * show and name that work while it runs. A terminal item event (completed,
 * failed, declined, interrupted) retires the entry; a session the cleanup
 * timer removes takes its entries with it.
 */
const codexBackgroundWork = new Map<string, Map<string, BackgroundTaskSummary>>();

const CODEX_BACKGROUND_TASK_TYPE = 'collab_agent';
const DETACHED_COMMAND_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'USER', 'LOGNAME', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
] as const;
const TASK_CREDENTIAL_ENV_NAMES = [
  'API_KEY',
  'CLOUDCLI_TASK_API_KEY',
  'CLOUDCLI_TASK_RUN_CONTEXT',
  'CLOUDCLI_REGISTRATION_TOKEN',
  'CLOUDCLI_TASK_TOKEN',
  'JWT_SECRET',
] as const;
const DETACHED_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function recordCodexBackgroundStart(appSessionId: string, item: { id: string; label: string; prompt?: string }): void {
  let tasks = codexBackgroundWork.get(appSessionId);
  if (!tasks) {
    tasks = new Map();
    codexBackgroundWork.set(appSessionId, tasks);
  }
  // Re-recorded starts refresh the entry in place; the original startedAt
  // survives so the strip's elapsed time does not jump.
  const previous = tasks.get(item.id);
  tasks.set(item.id, {
    taskId: item.id,
    toolUseId: item.id,
    taskType: CODEX_BACKGROUND_TASK_TYPE,
    description: item.prompt ? `${item.label}: ${item.prompt}` : item.label,
    startedAt: previous?.startedAt ?? Date.now(),
  });
}

function recordCodexBackgroundEnd(appSessionId: string, itemId: string): void {
  codexBackgroundWork.get(appSessionId)?.delete(itemId);
}

/**
 * One approval Codex is blocked on, waiting for a human.
 *
 * `app-server` asks for sandbox escalations as JSON-RPC *requests*, and the
 * turn stops until one is answered. The answer comes back over a different
 * connection entirely — the chat gateway's `chat.permission-response` — so the
 * two are joined here by the request id the `permission_request` frame
 * carried. Keyed module-wide because `permissions.resolve` is called from
 * outside any run.
 */
type PendingCodexApproval = {
  /** Answers the JSON-RPC request Codex is waiting on. */
  settle: (decision: ProviderPermissionDecision | null) => void;
  /** App session id, for `listPending`. */
  sessionId: string | null;
  toolName: string;
  toolId: string;
  input: unknown;
  receivedAt: Date;
};

const pendingCodexApprovals = new Map<string, PendingCodexApproval>();

/**
 * Item types whose in-flight state is worth showing before they finish.
 *
 * These are the ones a user waits on — a shell command, an MCP call, a patch
 * being applied, a spawned agent. Everything else either starts empty (text,
 * reasoning) or is already complete when announced.
 */
const PROGRESSIVE_CODEX_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'collabAgentToolCall',
]);

/** Default context window reported when the server has not said otherwise. */
const DEFAULT_CODEX_CONTEXT_WINDOW = 200000;

/**
 * Maps a permission mode onto the two knobs `thread/start` takes.
 *
 * Unchanged from the `codex exec` mapping this replaced, so a mode decides
 * exactly what it decided before — except that `on-request` now means what it
 * says: the escalation reaches the user's approval card instead of dying in a
 * transport with nobody to ask.
 *
 * Who reviews an approval is deliberately not set here: Codex's own
 * `approvals_reviewer` config decides whether a request is auto-reviewed
 * before it ever reaches a client, and overriding that would quietly undo a
 * setting the user made.
 */
function mapPermissionModeToCodexOptions(permissionMode: string): { sandbox: string; approvalPolicy: string } {
  const policy = resolveCodexExecutionPolicy(permissionMode);
  return { sandbox: policy.sandbox, approvalPolicy: policy.approvalPolicy };
}

/**
 * The server-to-client requests that are an approval the user can answer.
 *
 * Anything else app-server may ask for (MCP elicitations, tool-side user
 * input) is answered as unimplemented rather than guessed at.
 */
const CODEX_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
const TASK_MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request';

/**
 * Builds the reply one approval request expects.
 *
 * The command and file-change requests share a four-value decision; the
 * permission request instead answers with the profile it is granted, so
 * refusing it means granting nothing.
 *
 * A null decision is a request nobody answered — a timeout, or the run ending
 * underneath it — and is refused, never approved.
 */
function toCodexApprovalResponse(
  method: string,
  params: AnyRecord,
  decision: ProviderPermissionDecision | null,
): AnyRecord {
  if (method === 'item/permissions/requestApproval') {
    const requested = readObjectRecord(params.permissions) ?? {};
    return decision?.allow
      ? {
        permissions: {
          ...(requested.network ? { network: requested.network } : {}),
          ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
        },
        scope: decision.rememberEntry ? 'session' : 'turn',
      }
      : { permissions: {}, scope: 'turn' };
  }

  if (!decision?.allow) {
    return { decision: 'decline' };
  }
  // "Remember this" is a session-scoped approval on Codex's side.
  return { decision: decision.rememberEntry ? 'acceptForSession' : 'accept' };
}

/** Turns the shared input items into the `UserInput` shape app-server accepts. */
function toAppServerInput(items: Array<AnyRecord>): AnyRecord[] {
  return items.map((item) => {
    if (item.type === 'local_image') {
      return { type: 'localImage', path: item.path };
    }
    return { type: 'text', text: String(item.text ?? ''), text_elements: [] };
  });
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveCodexTerminalStatus(
  status: 'completed' | 'failed' | 'interrupted' | 'unknown',
  hasTerminalFailure: boolean,
): 'completed' | 'failed' | 'interrupted' | 'unknown' {
  return hasTerminalFailure && status === 'completed' ? 'failed' : status;
}

/** Reads the context budget out of a `thread/tokenUsage/updated` notification. */
function readCodexTokenBudget(params: AnyRecord) {
  const usage = readObjectRecord(params.tokenUsage);
  const total = readObjectRecord(usage?.total);
  if (!total) {
    return null;
  }

  const inputTokens = Number(total.inputTokens) || 0;
  const outputTokens = Number(total.outputTokens) || 0;
  return {
    used: Number(total.totalTokens) || inputTokens + outputTokens,
    total: Number(usage?.modelContextWindow) || DEFAULT_CODEX_CONTEXT_WINDOW,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/**
 * Sends one runtime message through the run's writer.
 *
 * `ProviderRuntimeWriter.send` already owns payload stringification, so — like
 * every other provider runtime — the adapter passes the object straight
 * through.
 */
function sendMessage(ws: ProviderRuntimeWriter, data: unknown) {
  try {
    ws.send(data);
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

/**
 * Executes one Codex turn and streams it to the client.
 */
async function queryCodex(
  command: string,
  options: AnyRecord = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    files,
    permissionMode = 'default',
  } = options;
  const appSessionId = typeof sessionId === 'string' ? sessionId : null;
  // The websocket session id may be numeric; the notification helpers take a
  // string user id, so normalize once here (mirrors antigravity-runtime).
  const normalizedUserId = ws?.userId != null ? String(ws.userId) : null;

  // Callers pass the stable app session id; the thread is resumed with the
  // provider-native id recorded on the session row.
  const taskContinuationTarget = readObjectRecord(options.taskContinuationTarget);
  const pinnedProviderThreadId = typeof taskContinuationTarget?.providerThreadId === 'string'
    ? taskContinuationTarget.providerThreadId
    : null;
  const providerSessionId = pinnedProviderThreadId ?? context.resolveProviderSessionId(sessionId);
  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  const workingDirectory = typeof taskContinuationTarget?.workingDirectory === 'string'
    ? taskContinuationTarget.workingDirectory
    : cwd || projectPath || process.cwd();
  const taskSandboxPolicyType = taskContinuationTarget?.sandboxPolicyType;
  const taskApprovalPolicy = taskContinuationTarget?.approvalPolicy;
  const targetPermissionMode = taskSandboxPolicyType === 'dangerFullAccess'
    ? 'bypassPermissions'
    : taskApprovalPolicy === 'never' ? 'acceptEdits' : permissionMode;
  const { sandbox, approvalPolicy } = mapPermissionModeToCodexOptions(targetPermissionMode);
  const taskExecutionContext = readObjectRecord(options.taskExecutionContext);
  const taskContinuationLifecycle = readObjectRecord(options.taskContinuationLifecycle);
  const onEngineTurnStarted = typeof taskContinuationLifecycle?.onEngineTurnStarted === 'function'
    ? taskContinuationLifecycle.onEngineTurnStarted as (engineTurnId: string) => unknown
    : null;
  const onNativeThreadResolved = typeof taskContinuationLifecycle?.onNativeThreadResolved === 'function'
    ? taskContinuationLifecycle.onNativeThreadResolved as (threadId: string) => unknown
    : null;
  const taskRunToken = typeof taskExecutionContext?.token === 'string'
    ? taskExecutionContext.token
    : '';
  const taskMcpOptions = taskRunToken
    ? getTaskMcpRuntimeOptions({ token: taskRunToken })
    : null;
  const catalog = await context.getProviderModels();
  const resolvedEffort = resolveModelEffort(resolvedModel, effort, catalog);

  let capturedSessionId: string | null = providerSessionId ?? null;
  let runSession: ActiveCodexSession | null = null;
  let sessionCreatedSent = false;
  let terminalFailure: { message: string } | null = null;
  let errorSurfaced = false;
  let connection: CodexAppServerConnection | null = null;
  let engineTurnId: string | null = null;
  let terminalStatus: 'completed' | 'failed' | 'interrupted' | 'unknown' = 'unknown';
  let acceptedTurnCallbackSent = false;

  const recordStartedTurn = (turnId: string | null): void => {
    if (!turnId) return;
    if (engineTurnId && engineTurnId !== turnId) {
      terminalFailure = { message: 'Codex reported different turn ids for one continuation.' };
      terminalStatus = 'unknown';
      return;
    }
    engineTurnId = turnId;
    if (!acceptedTurnCallbackSent) {
      acceptedTurnCallbackSent = true;
      onEngineTurnStarted?.(turnId);
    }
  };

  /** Session-map key: the app session id, else the thread id once captured. */
  const sessionKey = () => sessionId || capturedSessionId || null;
  // Keep this run's identity. A newer run can replace the map entry while an
  // aborted connection is still settling; the older run must not observe or
  // mutate the newer run's state.
  const currentSession = () => runSession;

  // Both `error` and `turn/completed` can report the same terminal cause.
  const surfaceFailure = (message: string): void => {
    if (errorSurfaced && terminalFailure?.message === message) {
      return;
    }
    terminalFailure = { message };
    errorSurfaced = true;
    sendMessage(ws, createNormalizedMessage({
      kind: 'error',
      content: message,
      sessionId: capturedSessionId || sessionId || null,
      provider: 'codex',
    }));
  };

  /** Resolves once the turn reaches a terminal state, or the child dies. */
  let settleTurn: (() => void) | null = null;
  const turnSettled = new Promise<void>((resolve) => {
    settleTurn = () => {
      settleTurn = null;
      resolve();
    };
  });
  const settle = () => settleTurn?.();

  /**
   * The tool row each item produced, by item id.
   *
   * An approval request names only the item it is about, so this is what lets
   * the prompt say *which* command or edit is waiting — Codex announces the
   * item before it asks.
   */
  const approvalSubjects = new Map<string, { toolName: string; input: unknown }>();

  const emitItem = (rawItem: unknown, timestamp: string, source: 'started' | 'completed'): void => {
    const item = readCodexAppServerItem(rawItem);
    if (!item) {
      return;
    }
    // A collab agent's lifecycle feeds the background-work tracker: the agent
    // outlives the turn, and the running-sessions poll needs to know it is
    // still going after the composer's own indicator has handed the session
    // over from "responding" to "background work". Keyed like Claude's
    // tracker: the app session id when the run knows one, the native thread
    // id as the fallback for a brand-new session's first turn. Which event
    // announced the item — not the item's own status field, which `started`
    // events may omit — decides between tracked and retired: an unrecognized
    // status parses as `completed`, and trusting it on `started` would drop
    // the agent before its first tick.
    const backgroundWorkKey = sessionId || capturedSessionId;
    if (item.kind === 'collab_spawn' && backgroundWorkKey) {
      if (source === 'started') {
        recordCodexBackgroundStart(backgroundWorkKey, item);
      } else {
        recordCodexBackgroundEnd(backgroundWorkKey, item.id);
      }
    }
    for (const row of codexThreadItemToRows(item, timestamp)) {
      if (row.type === 'tool_use' && !approvalSubjects.has(item.id)) {
        approvalSubjects.set(item.id, { toolName: String(row.toolName), input: row.toolInput });
      }
      for (const message of context.normalizeMessage(row, capturedSessionId || sessionId || null)) {
        sendMessage(ws, message);
      }
    }
  };

  /** Approvals this run opened, so the run's end can retract them. */
  const openApprovalIds = new Set<string>();

  /**
   * Puts one approval in front of the user and waits for the answer.
   *
   * Codex is blocked on the JSON-RPC request until this resolves, so the wait
   * is unbounded on purpose: a prompt that times out on its own would deny an
   * action the user was still reading.
   */
  const requestApproval = (method: string, params: AnyRecord): Promise<ProviderPermissionDecision | null> => {
    const itemId = readNonEmptyString(params.itemId) ?? randomUUID();
    const requestId = randomUUID();
    // A command approval is asked *before* the item is announced and carries
    // the command itself; everything else is asked about an item the user has
    // already seen announced, so the card is rebuilt from that row.
    const command = readNonEmptyString(params.command);
    const subject = command
      ? { toolName: 'Bash', input: JSON.stringify({ command: readCodexCommandLine(command) }) }
      : approvalSubjects.get(itemId);
    const reason = readNonEmptyString(params.reason);

    return new Promise<ProviderPermissionDecision | null>((resolve) => {
      let settled = false;
      const settleOnce = (decision: ProviderPermissionDecision | null) => {
        if (settled) {
          return;
        }
        settled = true;
        pendingCodexApprovals.delete(requestId);
        openApprovalIds.delete(requestId);
        resolve(decision);
      };

      pendingCodexApprovals.set(requestId, {
        settle: settleOnce,
        sessionId: appSessionId || capturedSessionId || null,
        toolName: subject?.toolName ?? 'Codex',
        toolId: itemId,
        input: subject?.input,
        receivedAt: new Date(),
      });
      openApprovalIds.add(requestId);

      sendMessage(ws, createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName: subject?.toolName ?? 'Codex',
        toolId: itemId,
        input: subject?.input,
        context: {
          // What Codex is asking for beyond running the tool: network access,
          // a write outside the workspace, and so on.
          reason: reason ?? (method === 'item/fileChange/requestApproval'
            ? 'Codex wants to write outside its sandbox.'
            : 'Codex wants to step outside its sandbox.'),
        },
        canInterrupt: true,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
    }).then((decision) => {
      // Every attached tab drops the prompt, including one that reconnects
      // mid-run and replays the request frame.
      sendMessage(ws, createNormalizedMessage({
        kind: 'permission_resolved',
        requestId,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
      return decision;
    });
  };

  /** Retracts anything still waiting, so a finished run leaves no live prompt. */
  const cancelOpenApprovals = (reason: string): void => {
    for (const requestId of [...openApprovalIds]) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'permission_cancelled',
        requestId,
        reason,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
      pendingCodexApprovals.get(requestId)?.settle(null);
    }
  };

  try {
    connection = await codexAppServerTransport.open({
      onExit: (reason) => {
        if (currentSession()?.status !== 'aborted' && !terminalFailure) {
          terminalFailure = { message: reason };
        }
        settle();
      },
      onRequest: async (method, params) => {
        if (method === TASK_MCP_ELICITATION_METHOD) {
          if (!taskMcpOptions || params.serverName !== TASK_MCP_NAME) {
            return undefined;
          }
          // CloudCLI's current permission card cannot collect form answers or complete URL handshakes.
          return { action: 'decline', content: null };
        }
        if (!CODEX_APPROVAL_METHODS.has(method)) {
          return undefined;
        }
        const decision = await requestApproval(method, params);
        return toCodexApprovalResponse(method, params, decision);
      },
      onNotification: (method, params) => {
        const session = currentSession();
        if (session?.status === 'aborted') {
          return;
        }

        const notificationRecord = readObjectRecord(params);
        const turnRecord = readObjectRecord(notificationRecord?.turn);
        const itemRecord = readObjectRecord(notificationRecord?.item);
        const eventThreadId =
          readNonEmptyString(notificationRecord?.threadId) ??
          readNonEmptyString(notificationRecord?.thread_id) ??
          readNonEmptyString(turnRecord?.threadId) ??
          readNonEmptyString(turnRecord?.thread_id) ??
          readNonEmptyString(itemRecord?.threadId) ??
          readNonEmptyString(itemRecord?.thread_id) ??
          null;

        // Subagents in multi-agent mode emit their own lifecycle events on the same
        // app-server connection. Only events for the target thread (the parent session)
        // drive this turn's terminal state, live transcript, and token updates.
        if (eventThreadId && capturedSessionId && eventThreadId !== capturedSessionId) {
          return;
        }

        switch (method) {
          case 'turn/started': {
            const turn = readObjectRecord(params.turn);
            const turnId = typeof turn?.id === 'string' ? turn.id : null;
            if (turnId) {
              recordStartedTurn(turnId);
            }
            const active = currentSession();
            if (active) {
              active.turnId = turnId;
            }
            return;
          }

          case 'item/started': {
            // Only work the user waits on is worth showing before it
            // finishes. Text and reasoning items start empty — their content
            // arrives as deltas — and a user message announced twice would be
            // appended twice, because a transcript row is appended on arrival
            // and only reconciled against *history* by id.
            const startedType = readObjectRecord(params.item)?.type;
            if (typeof startedType === 'string' && PROGRESSIVE_CODEX_ITEM_TYPES.has(startedType)) {
              emitItem(params.item, new Date().toISOString(), 'started');
            }
            return;
          }

          case 'item/completed':
            emitItem(params.item, new Date().toISOString(), 'completed');
            return;

          case 'item/agentMessage/delta': {
            // Streamed prose has its own protocol frame: the client grows one
            // placeholder from the fragments and the completed item's row
            // then takes its place. Re-sending the whole text as a `text` row
            // per delta instead appends one row per fragment.
            if (typeof params.delta === 'string' && params.delta) {
              sendMessage(ws, createNormalizedMessage({
                kind: 'stream_delta',
                role: 'assistant',
                content: params.delta,
                sessionId: capturedSessionId || sessionId || null,
                provider: 'codex',
              }));
            }
            return;
          }

          case 'thread/tokenUsage/updated': {
            const tokenBudget = readCodexTokenBudget(params);
            if (tokenBudget) {
              sendMessage(ws, createNormalizedMessage({
                kind: 'status',
                text: 'token_budget',
                tokenBudget,
                sessionId: capturedSessionId || sessionId || null,
                provider: 'codex',
              }));
            }
            return;
          }

          case 'error': {
            const error = readObjectRecord(params.error);
            const message = readNonEmptyString(error?.message)?.trim()
              || readNonEmptyString(params.message)?.trim()
              || 'Codex reported an error.';
            // A recoverable stream error is progress, not a failed turn. Keep
            // its cause in logs without adding a permanent chat error row.
            if (params.willRetry === true) {
              console.warn('[Codex] Retrying turn:', message);
              return;
            }
            surfaceFailure(message);
            return;
          }

          case 'turn/completed': {
            const turn = readObjectRecord(params.turn);
            if (typeof turn?.id === 'string') engineTurnId = turn.id;
            terminalStatus = turn?.status === 'completed'
              ? 'completed'
              : turn?.status === 'failed'
                ? 'failed'
                : turn?.status === 'interrupted'
                  ? 'interrupted'
                  : 'unknown';
            if (turn?.status === 'failed') {
              const error = readObjectRecord(turn.error);
              const message = readNonEmptyString(error?.message)?.trim() || terminalFailure?.message || 'Turn failed';
              surfaceFailure(message);
              notifyRunFailed({
                userId: normalizedUserId,
                provider: 'codex',
                sessionId: appSessionId || capturedSessionId || null,
                sessionName: sessionSummary,
                error: terminalFailure,
              });
            }
            if (turn?.status === 'interrupted' && currentSession()?.status !== 'aborted') {
              // Codex ends a usage-limit, shutdown, or engine-internal interrupt
              // here rather than at `failed` — on codex 0.155 a spawned agent
              // finishing mid-turn aborted the whole agent tree as `interrupted`
              // (fixed upstream in 0.156/#45549 and 0.157/#47340). Treating the
              // status as a normal completion sent the client a clean `complete`
              // while the rollout recorded `turn_aborted`, so the abort was
              // invisible until history re-read it and diagnostics logged the run
              // as a success. A stop the user asked for (`abort` already flagged
              // the session) arrives as the same status and must stay silent.
              const message = terminalFailure?.message ?? 'Codex interrupted this turn before it finished. This can mean an account usage limit, or the engine stopping the turn itself. Sending a message continues from where it stopped.';
              surfaceFailure(message);
              notifyRunFailed({
                userId: normalizedUserId,
                provider: 'codex',
                sessionId: appSessionId || capturedSessionId || null,
                sessionName: sessionSummary,
                error: terminalFailure,
              });
            }
            settle();
            return;
          }

          default:
            return;
        }
      },
    }, taskMcpOptions ? { env: taskMcpOptions.env } : undefined);

    const registerSession = (id: string | null) => {
      if (!id || !connection) {
        return;
      }
      runSession = {
        connection,
        threadId: capturedSessionId,
        turnId: null,
        status: 'running',
        startedAt: new Date().toISOString(),
      };
      activeCodexSessions.set(id, runSession);
    };

    if (sessionKey()) {
      registerSession(sessionKey());
    }

    const effectiveShellExcludes = taskMcpOptions
      ? await readEffectiveShellEnvironmentExcludes(connection, workingDirectory)
      : [];

    // `config` carries the settings the protocol has no field of its own for.
    const threadSettings: AnyRecord = {
      cwd: workingDirectory,
      sandbox,
      approvalPolicy,
      config: {
        'features.defer_mailbox_preemption': true,
        ...(taskMcpOptions?.config ?? {}),
        ...(taskMcpOptions ? {
          'shell_environment_policy.exclude': [...new Set([
            ...effectiveShellExcludes,
            TASK_API_KEY_ENV,
            TASK_RUN_CONTEXT_ENV,
          ])],
        } : {}),
      },
      ...(resolvedModel ? { model: resolvedModel } : {}),
    };
    const thread = readObjectRecord(providerSessionId
      ? await connection.call('thread/resume', {
        threadId: providerSessionId,
        excludeTurns: true,
        ...threadSettings,
      })
      : await connection.call('thread/start', threadSettings));

    const threadRecord = readObjectRecord(thread?.thread);
    const discoveredSessionId = typeof threadRecord?.id === 'string' ? threadRecord.id : null;
    if (discoveredSessionId) {
      onNativeThreadResolved?.(discoveredSessionId);
      const isNewThread = !capturedSessionId;
      capturedSessionId = discoveredSessionId;
      const existing = currentSession();
      if (existing) {
        existing.threadId = capturedSessionId;
      } else {
        registerSession(sessionKey());
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      if (isNewThread && !sessionCreatedSent) {
        sessionCreatedSent = true;
        sendMessage(ws, createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'codex',
        }));
      }
    }

    // Turns with image attachments send structured input items so Codex reads
    // the images from their local asset paths. The CLI requires non-empty
    // prompt text even when images carry the whole message, so an
    // attachment-only turn gets a small text instruction.
    const promptWithFiles = appendFilesInputTag(command, files);
    const normalizedImages = normalizeImageDescriptors(images);
    const promptForTurn = !promptWithFiles.trim() && normalizedImages.length > 0
      ? 'Please analyze the attached image(s).'
      : promptWithFiles;
    const inputItems = normalizedImages.length > 0
      ? buildCodexInputItems(promptForTurn, images, workingDirectory)
      : [{ type: 'text', text: promptForTurn }];

    if (!capturedSessionId) {
      throw new Error('Codex app-server opened no thread to run the turn in.');
    }

    const toolOutputParam = options.toolOutput ?? (options.taskContinuation ? {
      name: 'cloudcli_task_result',
      output: typeof options.taskContinuation === 'string'
        ? options.taskContinuation
        : JSON.stringify(options.taskContinuation),
    } : null);

    const startResult = readObjectRecord(await connection.call('turn/start', {
      threadId: capturedSessionId,
      input: toolOutputParam ? [] : toAppServerInput(inputItems as AnyRecord[]),
      ...(toolOutputParam ? { toolOutput: toolOutputParam } : {}),
      ...(resolvedEffort ? { effort: resolvedEffort } : {}),
    }));
    const startedTurn = readObjectRecord(startResult?.turn);
    recordStartedTurn(typeof startedTurn?.id === 'string' ? startedTurn.id : null);

    await turnSettled;

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runAborted = currentSession()?.status === 'aborted';
    if (runAborted) {
      terminalStatus = 'interrupted';
    }
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (!terminalFailure) {
        notifyRunStopped({
          userId: normalizedUserId,
          provider: 'codex',
          sessionId: appSessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
      }
    }

  } catch (error) {
    const runError = error instanceof Error ? error : new Error(String(error));
    const wasAborted =
      currentSession()?.status === 'aborted' ||
      runError.name === 'AbortError' ||
      runError.message.toLowerCase().includes('aborted');

    if (!wasAborted) {
      terminalStatus = 'failed';
      console.error('[Codex] Error:', error);

      if (!errorSurfaced) {
        const installed = await context.isProviderInstalled();
        const errorContent = !installed
          ? 'Codex CLI is not configured. Please set up authentication first.'
          : runError.message;

        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'codex',
        }));
      }
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: normalizedUserId,
          provider: 'codex',
          sessionId: appSessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error,
        });
      }
    } else {
      terminalStatus = 'interrupted';
    }

  } finally {
    cancelOpenApprovals('The run ended before this was answered.');
    connection?.close();
    const session = currentSession();
    if (session) {
      session.status = session.status === 'aborted' ? 'aborted' : 'completed';
    }
  }

  return {
    engineTurnId,
    terminalStatus: resolveCodexTerminalStatus(terminalStatus, Boolean(terminalFailure)),
  };
}

/**
 * Cancels an active Codex session.
 *
 * `turn/interrupt` is the graceful stop — it lets the server close the turn
 * out in the rollout — and the connection is closed behind it so a server
 * that ignores the interrupt cannot keep the run alive.
 */
function abortCodexSession(sessionId: string) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  console.log(
    `[Codex] Aborting session ${sessionId} (thread ${session.threadId ?? 'unknown'}, `
    + `turn ${session.turnId ?? 'none'}) — started ${session.startedAt}`,
  );
  if (session.threadId && session.turnId) {
    session.connection
      .call('turn/interrupt', { threadId: session.threadId, turnId: session.turnId })
      .catch((error: unknown) => {
        console.warn(`[Codex] Interrupt for session ${sessionId} was not accepted:`, error);
      });
  }
  // The connection is torn down on the next tick so the interrupt has a
  // chance to leave the process before its pipes close.
  setTimeout(() => session.connection.close(), 250).unref?.();

  return true;
}

/**
 * Used by the providers module's CodexProvider to run and abort turns, and to
 * answer the approvals a run is blocked on.
 *
 * Declaring `permissions` is also what turns `supportsPermissionRequests` on
 * for Codex in the capability catalog.
 */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
  permissions: {
    /**
     * Answers one approval. The gateway fans a decision out to every
     * provider, so an id this runtime never issued is simply not ours.
     */
    resolve(requestId: string, decision: ProviderPermissionDecision): void {
      pendingCodexApprovals.get(requestId)?.settle(decision);
    },

    /** The approvals this provider is waiting on for one session. */
    listPending(sessionId: string): unknown[] {
      const pending: unknown[] = [];
      for (const [requestId, approval] of pendingCodexApprovals.entries()) {
        if (approval.sessionId === sessionId) {
          pending.push({
            requestId,
            toolName: approval.toolName,
            toolId: approval.toolId,
            input: approval.input,
            receivedAt: approval.receivedAt,
            provider: 'codex',
          });
        }
      }
      return pending;
    },
  },
  /**
   * Sessions with collab agents still running, for the running-sessions poll.
   * The engine outlives turns, so an agent spawned mid-turn keeps working
   * after the turn's `result` — this is how the UI learns it is still going.
   */
  listBackgroundWork(): Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> {
    const entries: Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> = [];
    for (const [sessionId, tasks] of codexBackgroundWork) {
      if (tasks.size > 0) {
        entries.push({ sessionId, tasks: Array.from(tasks.values()) });
      }
    }
    return entries;
  },
};

/**
 * Runs argv through an independent Codex app-server `command/exec` call.
 * Consumed by task-continuations worker; the server process environment is
 * reduced to local runtime paths, and task/auth credentials are explicitly
 * removed from the command environment.
 */
export async function executeCodexSandboxCommand(input: {
  command: string[];
  cwd: string;
  sandboxPolicy: { type: 'workspaceWrite' | 'dangerFullAccess'; networkAccess: boolean };
  onStarted?: () => void;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!input.command.length || input.command.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
    || !path.isAbsolute(input.cwd)) {
    throw new Error('Codex sandbox command input is invalid.');
  }

  const workerEnv: NodeJS.ProcessEnv = {};
  for (const name of DETACHED_COMMAND_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) {
      workerEnv[name] = process.env[name];
    }
  }

  const connection = await codexAppServerTransport.open({}, { inheritEnv: false, env: workerEnv });
  try {
    input.onStarted?.();
    const response = readObjectRecord(await connection.call('command/exec', {
      command: input.command,
      cwd: input.cwd,
      sandboxPolicy: input.sandboxPolicy,
      env: Object.fromEntries(TASK_CREDENTIAL_ENV_NAMES.map((name) => [name, null])),
      timeoutMs: DETACHED_COMMAND_TIMEOUT_MS,
    }, { timeoutMs: DETACHED_COMMAND_TIMEOUT_MS }));
    const exitCode = response?.exitCode;
    if (!Number.isSafeInteger(exitCode)) {
      throw new Error('Codex command/exec returned no valid exit code.');
    }
    return {
      exitCode: exitCode as number,
      stdout: typeof response?.stdout === 'string' ? response.stdout : '',
      stderr: typeof response?.stderr === 'string' ? response.stderr : '',
    };
  } finally {
    connection.close();
  }
}

/** Kept so `thread/fork` stays reachable through this module's usual import site. */
export { codexAppServer };

// Clean up old completed sessions periodically
const completedSessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
        // The session's tracked agents went with its connection; entries left
        // here would keep a dead task on the background-work strip forever.
        codexBackgroundWork.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Runtime cleanup should not keep focused tests or one-off scripts alive after
// their provider work has completed.
completedSessionCleanupTimer.unref?.();

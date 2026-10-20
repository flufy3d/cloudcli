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
import { CODEX_BACKGROUND_TASK_TYPE, codexBackgroundWork } from '@/modules/providers/list/codex/codex-background-work.js';
import {
  acquireCodexResidentSession,
  closeCodexResidentSessionAdmission,
  completeCodexResidentRound,
  isCodexResidentSessionBusy,
  releaseCodexResidentSession,
  releaseCodexResidentSessionResources,
  stopCodexResidentRound,
  submitCodexResidentRound,
} from '@/modules/providers/list/codex/codex-session-manager.js';
import {
  buildCodexSubagentAgentRow,
  codexThreadItemToRows,
  readCodexAppServerItem,
  readCodexCommandLine,
  readCodexSubagentLabel,
  type CodexThreadItem,
} from '@/modules/providers/list/codex/codex-thread-items.js';
import { createBackgroundTasksStatusMessage, createTaskStatusMessage } from '@/modules/providers/shared/background-work/task-status.js';
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
import type { NormalizedMessage, SessionBackgroundWork } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

const TASK_MCP_NAME = 'cloudcli_task_continuations';
const TASK_API_URL_ENV = 'CLOUDCLI_TASK_API_URL';
const TASK_API_KEY_ENV = 'CLOUDCLI_TASK_API_KEY';
const TASK_RUN_CONTEXT_ENV = 'CLOUDCLI_TASK_RUN_CONTEXT';
const TASK_BRIDGE_ENV = 'CLOUDCLI_TASK_BRIDGE';

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

/**
 * The task MCP server's configuration and environment.
 *
 * A short-lived process carries the round's own capability and the global API
 * key. A resident process cannot: it outlives the round that started it, so
 * it carries a narrow bridge credential instead, and the host matches every
 * call against the engine call it observed.
 */
function getTaskMcpRuntimeOptions(input: {
  token?: string;
  bridgeToken?: string;
}): { config: Record<string, unknown>; env: NodeJS.ProcessEnv } {
  const apiUrl = process.env.CLOUDCLI_API_URL
    || `http://127.0.0.1:${process.env.SERVER_PORT || process.env.PORT || '3001'}`;
  const env: NodeJS.ProcessEnv = { [TASK_API_URL_ENV]: apiUrl.replace(/\/$/, '') };
  const envVars = [TASK_API_URL_ENV];
  if (input.bridgeToken) {
    env[TASK_BRIDGE_ENV] = input.bridgeToken;
    envVars.push(TASK_BRIDGE_ENV);
  } else {
    env[TASK_API_KEY_ENV] = process.env.API_KEY ?? '';
    env[TASK_RUN_CONTEXT_ENV] = input.token ?? '';
    envVars.push(TASK_API_KEY_ENV, TASK_RUN_CONTEXT_ENV);
  }
  return {
    config: {
      [`mcp_servers.${TASK_MCP_NAME}`]: {
        ...getTaskMcpCommand(),
        env_vars: envVars,
      },
    },
    env,
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
  /**
   * Ends the round: it interrupts a turn that already runs, or removes the
   * input that is still waiting in the engine's queue.
   */
  stop: () => void;
  /** Set once the server reports the turn; `turn/interrupt` needs it. */
  threadId: string | null;
  turnId: string | null;
  status: 'running' | 'aborted' | 'completed';
  startedAt: string;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();

/**
 * Whether a Codex conversation keeps its process alive between rounds.
 *
 * The resident path is what lets the engine report in the background while
 * the next message waits for its own turn, so it is off until the whole
 * delivery — background reports, task credentials, reclaim — is accepted.
 */
const isResidentSessionsEnabled = (): boolean => process.env.CLOUDCLI_CODEX_RESIDENT === '1';

const DETACHED_COMMAND_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'USER', 'LOGNAME', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
] as const;
const TASK_CREDENTIAL_ENV_NAMES = [
  'API_KEY',
  'CLOUDCLI_TASK_API_KEY',
  'CLOUDCLI_TASK_RUN_CONTEXT',
  'CLOUDCLI_TASK_BRIDGE',
  'CLOUDCLI_REGISTRATION_TOKEN',
  'CLOUDCLI_TASK_TOKEN',
  'JWT_SECRET',
] as const;
const DETACHED_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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
 * Where one set of Codex events goes.
 *
 * A foreground round delivers through the run's writer, so the gateway stamps
 * the run's sequence numbers and ends the run on its terminal event. A turn
 * the engine started by itself delivers through the session's publish entry:
 * that event belongs to the session, and it must not end a round nobody
 * started.
 */
type CodexEventTarget = {
  /** The app session the events belong to. */
  appSessionId: string | null;
  /** The native thread the conversation runs in. */
  threadId: () => string | null;
  /** Normalizes one provider row into the app's rows. */
  normalize: (raw: unknown, sessionId: string | null) => NormalizedMessage[];
  /** Delivers one row to the client. */
  deliver: (message: NormalizedMessage) => void;
  /** The tool each announced item needs, so an approval card can name it. */
  approvalSubjects: Map<string, { toolName: string; input: unknown }>;
  /**
   * Records one MCP tool call the engine made.
   *
   * A resident process outlives the round that started it, so the host takes
   * the authority for a call from the engine call it observed rather than
   * from a secret the process carries.
   */
  registerToolCall?: (call: { callId: string; server: string; tool: string }) => void;
};

/** One `task_status` frame for a collab agent, folded by the client onto the card of `toolUseId`. */
function codexTaskStatus(
  messageSessionId: string | null,
  taskId: string,
  toolUseId: string,
  fields: Parameters<typeof createTaskStatusMessage>[1],
) {
  return createTaskStatusMessage(
    { provider: 'codex', sessionId: messageSessionId, taskId, toolUseId, taskType: CODEX_BACKGROUND_TASK_TYPE },
    fields,
  );
}

/**
 * Re-sends the composer strip's list for a session; called after every change
 * to the agents tracked under `backgroundWorkKey`. The turn is in flight for
 * as long as an agent is tracked, so the work is always stoppable through the
 * turn.
 */
function broadcastCodexBackgroundTasks(target: CodexEventTarget, backgroundWorkKey: string): void {
  target.deliver(createBackgroundTasksStatusMessage(
    { provider: 'codex', sessionId: target.threadId() || target.appSessionId || null },
    codexBackgroundWork.listStripTasks(backgroundWorkKey),
    true,
  ));
}

/**
 * Draws and settles the Agent card of an agent announced only through its
 * activity record (the shape real engines use; see
 * `buildCodexSubagentAgentRow`). `started` opens the card, marks it running
 * and tracks the agent as background work under its thread id; `completed`
 * and `interrupted` settle the card they started — found through that
 * thread id, since the item id differs between the two — and retire the
 * entry. An end with no tracked start (the server restarted while the
 * agent ran) has no card to settle and is dropped. `interacted` is the
 * agents talking among themselves and draws nothing.
 */
function emitCodexSubagentActivity(
  target: CodexEventTarget,
  item: Extract<CodexThreadItem, { kind: 'subagent_activity' }>,
  timestamp: string,
  backgroundWorkKey: string | null | undefined,
): void {
  const messageSessionId = target.threadId() || target.appSessionId || null;
  if (item.activity === 'started') {
    const taskId = item.agentThreadId ?? item.id;
    if (backgroundWorkKey && codexBackgroundWork.get(backgroundWorkKey, taskId)) {
      return;
    }
    for (const message of target.normalize(buildCodexSubagentAgentRow(item, timestamp), messageSessionId)) {
      target.deliver(message);
    }
    const description = readCodexSubagentLabel(item);
    if (backgroundWorkKey) {
      codexBackgroundWork.start(backgroundWorkKey, {
        taskId,
        toolUseId: item.id,
        taskType: CODEX_BACKGROUND_TASK_TYPE,
        description,
      });
      broadcastCodexBackgroundTasks(target, backgroundWorkKey);
    }
    target.deliver(codexTaskStatus(messageSessionId, taskId, item.id, { event: 'started', description }));
    return;
  }

  if (item.activity !== 'completed' && item.activity !== 'interrupted') {
    return;
  }
  const tracked = backgroundWorkKey && item.agentThreadId
    ? codexBackgroundWork.end(backgroundWorkKey, item.agentThreadId)
    : undefined;
  if (!backgroundWorkKey || !tracked) {
    return;
  }
  broadcastCodexBackgroundTasks(target, backgroundWorkKey);
  target.deliver(codexTaskStatus(messageSessionId, tracked.taskId, tracked.toolUseId, {
    event: 'notification',
    status: item.activity === 'completed' ? 'completed' : 'stopped',
  }));
}

/**
 * Announces one engine item as the app's rows.
 *
 * A collab agent's lifecycle feeds the background-work tracker, so the
 * running-sessions poll and the composer's strip name the agents the turn
 * in flight is waiting on. Which event announced the item — not the item's
 * own status field, which `started` events may omit — decides between tracked
 * and retired: an unrecognized status parses as `completed`, and trusting it
 * on `started` would drop the agent before its first tick.
 */
function emitCodexItem(
  target: CodexEventTarget,
  rawItem: unknown,
  timestamp: string,
  source: 'started' | 'completed',
  backgroundWorkKey: string | null | undefined,
): void {
  const item = readCodexAppServerItem(rawItem);
  if (!item) {
    return;
  }
  if (item.kind === 'collab_spawn' && backgroundWorkKey) {
    if (source === 'started') {
      codexBackgroundWork.start(backgroundWorkKey, {
        taskId: item.id,
        toolUseId: item.id,
        taskType: CODEX_BACKGROUND_TASK_TYPE,
        description: item.prompt ? `${item.label}: ${item.prompt}` : item.label,
      });
      broadcastCodexBackgroundTasks(target, backgroundWorkKey);
    } else if (codexBackgroundWork.end(backgroundWorkKey, item.id)) {
      broadcastCodexBackgroundTasks(target, backgroundWorkKey);
    }
  }
  if (item.kind === 'mcp_tool_call') {
    target.registerToolCall?.({ callId: item.id, server: item.server, tool: item.tool });
  }
  if (item.kind === 'subagent_activity') {
    emitCodexSubagentActivity(target, item, timestamp, backgroundWorkKey);
    return;
  }
  for (const row of codexThreadItemToRows(item, timestamp)) {
    if (row.type === 'tool_use' && !target.approvalSubjects.has(item.id)) {
      target.approvalSubjects.set(item.id, { toolName: String(row.toolName), input: row.toolInput });
    }
    for (const message of target.normalize(row, target.threadId() || target.appSessionId || null)) {
      target.deliver(message);
    }
  }
}

/**
 * A running agent's own finished item, as a row tied to its card. Agents
 * work on their own thread of this connection; the thread id is how the
 * registry finds the card. The agent's prompt (the card's task) and its
 * lifecycle items are left out, the same as when history rebuilds the
 * timeline from the agent's rollout, so the card reads alike either way.
 * Threads this session did not spawn are ignored.
 */
function emitCodexAgentItem(
  target: CodexEventTarget,
  agentThreadId: string,
  rawItem: unknown,
  timestamp: string,
  backgroundWorkKey: string | null | undefined,
): void {
  const owner = codexBackgroundWork.find(agentThreadId);
  const item = readCodexAppServerItem(rawItem);
  if (!owner || owner.sessionKey !== backgroundWorkKey || !item || item.kind === 'user_message' || item.kind === 'subagent_activity') {
    return;
  }
  for (const row of codexThreadItemToRows(item, timestamp)) {
    for (const message of target.normalize(row, target.threadId() || target.appSessionId || null)) {
      target.deliver({ ...message, parentToolUseId: owner.task.toolUseId });
    }
  }
}

/**
 * The events of a turn the engine started on its own.
 *
 * The engine starts a turn to deliver a background result, and that turn
 * belongs to the session rather than to the round the user is waiting for.
 * Its events are published to the session, so they reach the tabs watching
 * the conversation without ending a round.
 *
 * The handler is bound to the session, not to a round: a resident process
 * reports after the round that started it is gone, so nothing here may
 * depend on that round's writer.
 */
function handleCodexSessionEvent(
  target: CodexEventTarget,
  method: string,
  params: AnyRecord,
): void {
  const backgroundWorkKey = target.appSessionId;
  const eventThreadId = readNonEmptyString(params.threadId) ?? readNonEmptyString(params.thread_id);
  if (eventThreadId && target.threadId() && eventThreadId !== target.threadId()) {
    // A subagent reports on the same connection, and its card still belongs
    // to the conversation the user is looking at.
    if (method === 'item/completed') {
      emitCodexAgentItem(target, eventThreadId, params.item, new Date().toISOString(), backgroundWorkKey);
    }
    return;
  }

  const sessionId = target.threadId() || target.appSessionId || null;
  switch (method) {
    case 'turn/started': {
      console.log(`[Codex] The engine started a turn of its own on thread ${target.threadId() ?? 'unknown'}.`);
      return;
    }

    case 'item/started': {
      const startedType = readObjectRecord(params.item)?.type;
      if (typeof startedType === 'string' && PROGRESSIVE_CODEX_ITEM_TYPES.has(startedType)) {
        emitCodexItem(target, params.item, new Date().toISOString(), 'started', backgroundWorkKey);
      }
      return;
    }

    case 'item/completed': {
      emitCodexItem(target, params.item, new Date().toISOString(), 'completed', backgroundWorkKey);
      return;
    }

    case 'item/agentMessage/delta': {
      if (typeof params.delta === 'string' && params.delta) {
        target.deliver(createNormalizedMessage({
          kind: 'stream_delta',
          role: 'assistant',
          content: params.delta,
          sessionId,
          provider: 'codex',
        }));
      }
      return;
    }

    case 'thread/tokenUsage/updated': {
      const tokenBudget = readCodexTokenBudget(params);
      if (tokenBudget) {
        target.deliver(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget,
          sessionId,
          provider: 'codex',
        }));
      }
      return;
    }

    case 'error': {
      const error = readObjectRecord(params.error);
      const message = readNonEmptyString(error?.message)?.trim() || readNonEmptyString(params.message)?.trim();
      if (message) {
        target.deliver(createNormalizedMessage({
          kind: 'error',
          content: message,
          sessionId,
          provider: 'codex',
        }));
      }
      return;
    }

    default:
      return;
  }
}

/**
 * The tool each announced item needs, per session.
 *
 * A resident session can be asked for an approval while no round is in
 * flight, and the card has to name the tool that waits.
 */
const sessionApprovalSubjects = new Map<string, Map<string, { toolName: string; input: unknown }>>();

/** The approval subjects of a session, created on first use. */
function readSessionApprovalSubjects(appSessionId: string | null): Map<string, { toolName: string; input: unknown }> {
  const key = appSessionId ?? '';
  const existing = sessionApprovalSubjects.get(key);
  if (existing) {
    return existing;
  }
  const created = new Map<string, { toolName: string; input: unknown }>();
  sessionApprovalSubjects.set(key, created);
  return created;
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
  /**
   * The task MCP options of a resident process.
   *
   * A resident process carries a narrow bridge credential instead of the
   * round's capability, because it outlives the round that started it. The
   * credential is bound to the process generation, so it is created when the
   * manager starts the process.
   */
  let residentTaskMcpOptions: { config: Record<string, unknown>; env: NodeJS.ProcessEnv } | null = null;
  const createResidentTaskMcpOptions = (generation: number) => {
    const bridge = context.createBridgeCredential?.({
      userId: normalizedUserId ?? '',
      appSessionId: residentKey,
      generation,
    });
    if (!bridge) {
      return null;
    }
    residentTaskMcpOptions = getTaskMcpRuntimeOptions({ bridgeToken: bridge.token });
    return residentTaskMcpOptions;
  };
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

  /**
   * The events of this round, delivered through the run's writer.
   *
   * The gateway stamps the round's sequence numbers and ends the round on its
   * terminal event, so a round's own events never travel the session's
   * publish entry.
   */
  const roundTarget: CodexEventTarget = {
    appSessionId: sessionId || null,
    threadId: () => capturedSessionId,
    normalize: (raw, nativeSessionId) => context.normalizeMessage(raw, nativeSessionId),
    deliver: (message) => sendMessage(ws, message),
    approvalSubjects,
    registerToolCall: (call) => {
      if (!taskRunToken || !capturedSessionId) {
        return;
      }
      context.registerEngineToolCall?.({
        appSessionId: sessionId || capturedSessionId,
        threadId: capturedSessionId,
        turnId: engineTurnId,
        callId: call.callId,
        server: call.server,
        tool: call.tool,
        runToken: taskRunToken,
      });
    },
  };

  /**
   * Re-sends the composer strip's list for this run's session; called after
   * every change to the agents tracked under `backgroundWorkKey`. The turn is
   * in flight for as long as an agent is tracked (the turn's end clears the
   * rest), so the work is always stoppable through the turn.
   */
  const broadcastBackgroundTasks = (backgroundWorkKey: string): void => {
    broadcastCodexBackgroundTasks(roundTarget, backgroundWorkKey);
  };

  /**
   * Settles every agent this run still tracks as `stopped`. The app-server is
   * a child process that `connection.close()` kills when the turn ends, and
   * the agents it ran die with it, so an agent still registered here will
   * never report: its card would spin forever. Called before the terminal
   * `complete` so the page never sees a finished turn with a running card;
   * a second call finds the registry already empty.
   */
  const settleOutstandingAgents = (): void => {
    const backgroundWorkKey = sessionId || capturedSessionId;
    if (!backgroundWorkKey) {
      return;
    }
    const outstanding = codexBackgroundWork.clearSession(backgroundWorkKey);
    if (outstanding.length === 0) {
      return;
    }
    broadcastBackgroundTasks(backgroundWorkKey);
    for (const task of outstanding) {
      sendMessage(ws, codexTaskStatus(capturedSessionId || sessionId || null, task.taskId, task.toolUseId, {
        event: 'notification',
        status: 'stopped',
      }));
    }
  };

  const emitItem = (rawItem: unknown, timestamp: string, source: 'started' | 'completed'): void => {
    emitCodexItem(roundTarget, rawItem, timestamp, source, sessionId || capturedSessionId);
  };

  /**
   * A running agent's own finished item, as a row tied to its card. Agents
   * work on their own thread of this connection; the thread id is how the
   * registry finds the card. The agent's prompt (the card's task) and its
   * lifecycle items are left out, the same as when history rebuilds the
   * timeline from the agent's rollout, so the card reads alike either way.
   * Threads this run did not spawn are ignored.
   */
  const emitAgentItem = (agentThreadId: string, rawItem: unknown, timestamp: string): void => {
    emitCodexAgentItem(roundTarget, agentThreadId, rawItem, timestamp, sessionId || capturedSessionId);
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
    // An approval for a running agent's thread names the agent's card.
    const askingThread = readNonEmptyString(params.threadId);
    const owner = askingThread && askingThread !== capturedSessionId ? codexBackgroundWork.find(askingThread) : undefined;
    const subagent = owner && owner.sessionKey === (sessionId || capturedSessionId)
      ? { toolUseId: owner.task.toolUseId, description: owner.task.description }
      : undefined;

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
          ...(subagent ? { subagent } : {}),
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

  /** Set when the process of this round died, which kills its agents with it. */
  let residentProcessExited = false;

  /**
   * Settles the agents of this round when nothing can be running any more.
   *
   * A resident process keeps the agents alive past the end of the round, so
   * they are only settled when the process itself is gone.
   */
  const settleAgentsWhenProcessIsGone = (): void => {
    if (!isResidentSessionsEnabled() || residentProcessExited) {
      settleOutstandingAgents();
    }
  };

  /**
   * The process died, so the round can never reach a terminal state.
   */
  const handleProcessExit = (reason: string): void => {
    residentProcessExited = true;
    if (currentSession()?.status !== 'aborted' && !terminalFailure) {
      terminalFailure = { message: reason };
    }
    settle();
  };

  /**
   * Answers the server-to-client requests the round has to handle.
   *
   * An approval waits for the user, so the answer must reach the request
   * that is still open.
   */
  const handleRoundRequest = async (method: string, params: AnyRecord) => {
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

  };

  /**
   * The events of the round's own turn.
   *
   * The events of a turn the engine started on its own never reach this
   * handler: a background report must not end the user's round.
   */
  const handleRoundEvent = (method: string, params: AnyRecord): void => {
    const session = currentSession();
    // A stop the user asked for silences the events that follow it, but the
    // terminal event still has to arrive: the round waits for it, and a
    // resident process keeps running after the stop, so nothing else would
    // ever settle the round.
    if (session?.status === 'aborted' && method !== 'turn/completed') {
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
      if (method === 'item/completed') {
        emitAgentItem(eventThreadId, params.item, new Date().toISOString());
      }
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

  };

  /**
   * The resident key is the app session id, so the next round of the same
   * conversation finds the process that is already running.
   */
  const residentKey = appSessionId ?? `codex-unbound-${randomUUID()}`;

  try {
    /**
     * Ends the round.
     *
     * A resident session interrupts the turn it started, or removes the input
     * that is still waiting in the engine's queue. A short connection is torn
     * down behind the interrupt.
     */
    const stopRound = () => {
      if (isResidentSessionsEnabled()) {
        void stopCodexResidentRound(residentKey);
        return;
      }
      const session = currentSession();
      if (session?.threadId && session.turnId) {
        connection?.call('turn/interrupt', { threadId: session.threadId, turnId: session.turnId })
          .catch((error: unknown) => {
            console.warn(`[Codex] Interrupt for session ${residentKey} was not accepted:`, error);
          });
      }
      // The connection is torn down on the next tick so the interrupt has a
      // chance to leave the process before its pipes close.
      setTimeout(() => connection?.close(), 250).unref?.();
    };

    const registerSession = (id: string | null) => {
      if (!id) {
        return;
      }
      runSession = {
        stop: stopRound,
        threadId: capturedSessionId,
        turnId: null,
        status: 'running',
        startedAt: new Date().toISOString(),
      };
      activeCodexSessions.set(id, runSession);
    };

    /** Records the native thread the conversation runs in. */
    const adoptNativeThread = (discoveredSessionId: string) => {
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
    };

    if (sessionKey()) {
      registerSession(sessionKey());
    }

    if (isResidentSessionsEnabled()) {
      const resident = await acquireCodexResidentSession({
        appSessionId: residentKey,
        nativeThreadId: providerSessionId,
        workingDirectory,
        env: (generation) => createResidentTaskMcpOptions(generation)?.env,
        config: async (openConnection) => {
          const excludes = residentTaskMcpOptions
            ? await readEffectiveShellEnvironmentExcludes(openConnection, workingDirectory)
            : [];
          return {
            'features.defer_mailbox_preemption': true,
            ...(residentTaskMcpOptions?.config ?? {}),
            ...(residentTaskMcpOptions ? {
              'shell_environment_policy.exclude': [...new Set([
                ...excludes,
                TASK_BRIDGE_ENV,
              ])],
            } : {}),
          };
        },
        approvalPolicy,
        sandboxMode: sandbox,
        onEngineEvent: (method, params, threadId) => handleCodexSessionEvent({
          appSessionId: residentKey,
          threadId: () => threadId,
          normalize: (raw, nativeSessionId) => context.normalizeMessage(raw, nativeSessionId),
          deliver: (message) => {
            context.publishSessionEvent?.(residentKey, message);
          },
          approvalSubjects: readSessionApprovalSubjects(residentKey),
        }, method, params),
        onSessionExit: handleProcessExit,
        isBusy: () => codexBackgroundWork.hasSession(residentKey),
      });
      connection = resident.connection;
      adoptNativeThread(resident.threadId);
    } else {
      connection = await codexAppServerTransport.open({
        onExit: handleProcessExit,
        onRequest: handleRoundRequest,
        onNotification: handleRoundEvent,
      }, taskMcpOptions ? { env: taskMcpOptions.env } : undefined);

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
        adoptNativeThread(discoveredSessionId);
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

    if (isResidentSessionsEnabled() && !toolOutputParam) {
      // The engine's queue is the admission gate: the input waits while the
      // thread is busy and becomes a turn of its own once it is idle.
      await submitCodexResidentRound({
        appSessionId: residentKey,
        input: toAppServerInput(inputItems as AnyRecord[]),
        model: resolvedModel ?? undefined,
        effort: resolvedEffort ?? undefined,
        workingDirectory,
        approvalPolicy,
        sandboxMode: sandbox,
        onEvent: handleRoundEvent,
        onRequest: handleRoundRequest,
      });
    } else {
      const startResult = readObjectRecord(await connection.call('turn/start', {
        threadId: capturedSessionId,
        input: toolOutputParam ? [] : toAppServerInput(inputItems as AnyRecord[]),
        ...(toolOutputParam ? { toolOutput: toolOutputParam } : {}),
        ...(resolvedEffort ? { effort: resolvedEffort } : {}),
      }));
      const startedTurn = readObjectRecord(startResult?.turn);
      recordStartedTurn(typeof startedTurn?.id === 'string' ? startedTurn.id : null);
    }

    await turnSettled;
    settleAgentsWhenProcessIsGone();

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
    settleAgentsWhenProcessIsGone();
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
    settleAgentsWhenProcessIsGone();
    const session = currentSession();
    if (session) {
      session.status = session.status === 'aborted' ? 'aborted' : 'completed';
    }
    if (isResidentSessionsEnabled()) {
      // The process stays alive: the next round continues in the same thread.
      completeCodexResidentRound(residentKey);
      if (!appSessionId) {
        // A run without an app session has no conversation to stay resident
        // for, so its process is closed with the round.
        releaseCodexResidentSession(residentKey, { dispose: true });
      }
    } else {
      connection?.close();
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

  // A session whose round is over has nothing to stop: the entry stays for
  // the diagnostics, but a stop must not report success for a round that
  // already ended.
  if (!session || session.status !== 'running') {
    return false;
  }

  session.status = 'aborted';
  console.log(
    `[Codex] Aborting session ${sessionId} (thread ${session.threadId ?? 'unknown'}, `
    + `turn ${session.turnId ?? 'none'}) — started ${session.startedAt}`,
  );
  session.stop();

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
   * The app-server dies with the turn, so these are the agents of turns still
   * in flight; the turn's end settles and removes the rest.
   */
  listBackgroundWork(): SessionBackgroundWork[] {
    return codexBackgroundWork.list();
  },
  /**
   * Whether the conversation still has work that must not be reclaimed.
   */
  hasSessionWork(sessionId: string): boolean {
    return isCodexResidentSessionBusy(sessionId);
  },
  /**
   * Stops new rounds from starting in the conversation, so an archive or a
   * delete can look at its state and act on it.
   */
  closeSessionAdmission(sessionId: string): void {
    closeCodexResidentSessionAdmission(sessionId);
  },
  /**
   * Releases the process the conversation kept alive between rounds.
   */
  releaseSession(sessionId: string): void {
    releaseCodexResidentSessionResources(sessionId);
  },
  /** What the composer's strip shows for a session that subscribes mid-turn. */
  backgroundTasks: {
    list: (sessionId: string) => codexBackgroundWork.listStripTasks(sessionId),
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
        // A run settles its own agents when its turn ends; this only drops
        // entries a run that never reached its end left behind.
        codexBackgroundWork.clearSession(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Runtime cleanup should not keep focused tests or one-off scripts alive after
// their provider work has completed.
completedSessionCleanupTimer.unref?.();

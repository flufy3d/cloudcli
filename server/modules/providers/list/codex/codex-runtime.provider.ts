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

import {
  codexAppServer,
  codexAppServerTransport,
  type CodexAppServerConnection,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import {
  codexThreadItemToRows,
  readCodexAppServerItem,
} from '@/modules/providers/list/codex/codex-thread-items.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors,
  createCompleteMessage,
  createNormalizedMessage,
  resolveModelEffort,
} from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';
import { readObjectRecord } from '@/shared/utils.js';

type ActiveCodexSession = {
  connection: CodexAppServerConnection;
  /** Set once the server reports the turn; `turn/interrupt` needs it. */
  threadId: string | null;
  turnId: string | null;
  status: 'running' | 'aborted' | 'completed';
  startedAt: string;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();

/** Default context window reported when the server has not said otherwise. */
const DEFAULT_CODEX_CONTEXT_WINDOW = 200000;

/**
 * Maps a permission mode onto the two knobs `thread/start` takes.
 *
 * Unchanged from the `codex exec` mapping this replaced, so a mode decides
 * exactly what it decided before. What an approval request means is the one
 * difference and it is handled at the request itself.
 */
function mapPermissionModeToCodexOptions(permissionMode: string): { sandbox: string; approvalPolicy: string } {
  switch (permissionMode) {
    case 'acceptEdits':
      return { sandbox: 'workspace-write', approvalPolicy: 'never' };
    case 'bypassPermissions':
      return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
    case 'default':
    default:
      // Codex 0.153 removed `untrusted`; `on-request` keeps a live approval
      // gate in front of sandbox escalations.
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
  }
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
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandbox, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const catalog = await context.getProviderModels();
  const resolvedEffort = resolveModelEffort(resolvedModel, effort, catalog);

  let capturedSessionId: string | null = providerSessionId ?? null;
  let sessionCreatedSent = false;
  let terminalFailure: { message: string } | null = null;
  let errorSurfaced = false;
  let connection: CodexAppServerConnection | null = null;

  /** Session-map key: the app session id, else the thread id once captured. */
  const sessionKey = () => sessionId || capturedSessionId || null;
  const currentSession = () => activeCodexSessions.get(sessionKey() || '');

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
   * Text that has streamed but whose item has not completed yet, per item id.
   * The completed item carries the whole text, so these are only the bridge
   * between the two.
   */
  const streamedText = new Map<string, string>();

  const emitItem = (rawItem: unknown, timestamp: string): void => {
    const item = readCodexAppServerItem(rawItem);
    if (!item) {
      return;
    }
    for (const row of codexThreadItemToRows(item, timestamp)) {
      for (const message of context.normalizeMessage(row, capturedSessionId || sessionId || null)) {
        sendMessage(ws, message);
      }
    }
  };

  /** Emits the partial form of a text-bearing item as it streams. */
  const emitStreamedText = (itemId: string, kind: 'agent_message' | 'reasoning', delta: string): void => {
    const text = (streamedText.get(itemId) ?? '') + delta;
    streamedText.set(itemId, text);
    const rows = codexThreadItemToRows({ kind, id: itemId, text }, new Date().toISOString());
    for (const row of rows) {
      for (const message of context.normalizeMessage(row, capturedSessionId || sessionId || null)) {
        sendMessage(ws, message);
      }
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
      onRequest: (method, params) => {
        // Nothing in the app can answer an approval, so one is refused rather
        // than left to block the turn forever. Codex's own auto-reviewer
        // settles the common cases before they ever reach a client.
        if (method.endsWith('/requestApproval')) {
          const itemId = typeof params.itemId === 'string' ? params.itemId : null;
          if (itemId) {
            // Named after the item it refused, so the note is one row rather
            // than a new one per retry.
            sendMessage(ws, createNormalizedMessage({
              id: `${itemId}_approval`,
              kind: 'task_notification',
              summary: 'Codex asked to step outside its sandbox. CloudCLI has no approval prompt, so the request was refused.',
              status: 'info',
              sessionId: capturedSessionId || sessionId || null,
              provider: 'codex',
            }));
          }
          return { decision: 'decline' };
        }
        return undefined;
      },
      onNotification: (method, params) => {
        const session = currentSession();
        if (session?.status === 'aborted') {
          return;
        }

        switch (method) {
          case 'turn/started': {
            const turn = readObjectRecord(params.turn);
            const turnId = typeof turn?.id === 'string' ? turn.id : null;
            const active = currentSession();
            if (active) {
              active.turnId = turnId;
            }
            return;
          }

          case 'item/started':
          case 'item/completed':
            emitItem(params.item, new Date().toISOString());
            return;

          case 'item/agentMessage/delta': {
            const itemId = typeof params.itemId === 'string' ? params.itemId : null;
            if (itemId && typeof params.delta === 'string') {
              emitStreamedText(itemId, 'agent_message', params.delta);
            }
            return;
          }

          case 'item/reasoning/summaryTextDelta': {
            const itemId = typeof params.itemId === 'string' ? params.itemId : null;
            if (itemId && typeof params.delta === 'string') {
              emitStreamedText(itemId, 'reasoning', params.delta);
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
            errorSurfaced = true;
            const message = typeof params.message === 'string' ? params.message : 'Codex reported an error.';
            terminalFailure = terminalFailure ?? { message };
            sendMessage(ws, createNormalizedMessage({
              kind: 'error',
              content: message,
              sessionId: capturedSessionId || sessionId || null,
              provider: 'codex',
            }));
            return;
          }

          case 'turn/completed': {
            const turn = readObjectRecord(params.turn);
            if (turn?.status === 'failed') {
              const error = readObjectRecord(turn.error);
              const message = typeof error?.message === 'string' ? error.message : 'Turn failed';
              terminalFailure = { message };
              errorSurfaced = true;
              sendMessage(ws, createNormalizedMessage({
                kind: 'error',
                content: message,
                sessionId: capturedSessionId || sessionId || null,
                provider: 'codex',
              }));
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
    });

    const registerSession = (id: string | null) => {
      if (!id || !connection) {
        return;
      }
      activeCodexSessions.set(id, {
        connection,
        threadId: capturedSessionId,
        turnId: null,
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    };

    if (sessionKey()) {
      registerSession(sessionKey());
    }

    // `config` carries the settings the protocol has no field of its own for.
    const threadSettings: AnyRecord = {
      cwd: workingDirectory,
      sandbox,
      approvalPolicy,
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
    // the images from their local asset paths.
    const promptWithFiles = appendFilesInputTag(command, files);
    const inputItems = normalizeImageDescriptors(images).length > 0
      ? buildCodexInputItems(promptWithFiles, images, workingDirectory)
      : [{ type: 'text', text: promptWithFiles }];

    if (!capturedSessionId) {
      throw new Error('Codex app-server opened no thread to run the turn in.');
    }

    await connection.call('turn/start', {
      threadId: capturedSessionId,
      input: toAppServerInput(inputItems as AnyRecord[]),
      ...(resolvedEffort ? { effort: resolvedEffort } : {}),
    });

    await turnSettled;

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runAborted = currentSession()?.status === 'aborted';
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
    }

  } finally {
    connection?.close();
    const session = currentSession();
    if (session) {
      session.status = session.status === 'aborted' ? 'aborted' : 'completed';
    }
  }
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

/** Used by the providers module's CodexProvider to run and abort turns. */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
};

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
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Runtime cleanup should not keep focused tests or one-off scripts alive after
// their provider work has completed.
completedSessionCleanupTimer.unref?.();

import fsSync from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

import crossSpawn from 'cross-spawn';
import Database from 'better-sqlite3';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  readObjectRecord,
  readOptionalString,
  resolveModelEffort
} from '@/shared/utils.js';

import { readOpenCodeContextUsage } from './opencode-context-usage.js';
import { getOpenCodeDatabasePath } from './opencode-data-root.js';
import { openCodeFetch } from './opencode-http.client.js';
import {
  abortOpenCodeSession as abortOpenCodeServerSession,
  acquireOpenCodeServer,
  createOpenCodeSession,
  getOpenCodeSessionStatus,
  isOpenCodeAsyncPromptUnsupportedError,
  isOpenCodeServerReachable,
  openCodeServerSupportsAsyncPrompt,
  releaseOpenCodeServer,
  resolveOpenCodeAgent,
  sendOpenCodeMessage,
  sendOpenCodeMessageAsync,
  subscribeOpenCodeEvents,
} from './opencode-server.client.js';
import {
  handleOpenCodeApprovalEvent,
  isOpenCodeApprovalEvent,
  openCodePermissions,
  registerOpenCodeRun,
  unregisterOpenCodeRun,
} from './opencode-permissions.provider.js';
import { readOpenCodeTaskDelivery } from './opencode-sessions.provider.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

/**
 * Active runs keyed by both the app session id and the provider-native session
 * id, so `chat.abort` (which addresses the app id) always finds the run.
 */
const activeRuns = new Map();

/**
 * Shortest gap between two mid-turn context-usage reads.
 *
 * OpenCode only reports usage when the whole run ends, so a long tool-heavy
 * turn needs the runtime to publish it mid-turn (see `publishLiveTokenBudget`).
 * Each read opens `opencode.db` and walks the session's message rows, so it
 * must not run on every streamed message update.
 */
const LIVE_CONTEXT_MIN_INTERVAL_MS = 1_500;

/**
 * Longest wait, after a turn's prompt request resolved, for the session's idle
 * event that ends its stream tail (see `drainOpenCodeRun`). The tail normally
 * lands within milliseconds; this only bounds a lost event.
 */
const RUN_IDLE_EVENT_TIMEOUT_MS = 3_000;

/**
 * Default window for an accepted async prompt to show any sign of life before
 * the engine is presumed to have dropped it (see
 * `confirmOpenCodePromptStarted`). `OPENCODE_PROMPT_START_TIMEOUT_MS` overrides
 * it per run, which tests use to exercise the failure path quickly.
 */
const PROMPT_START_TIMEOUT_DEFAULT_MS = 60_000;

/** Cadence of the start check while waiting for the engine to pick up a prompt. */
const PROMPT_START_POLL_INTERVAL_MS = 1_500;

/** How often the settle loop asks the engine when no event wakes it sooner. */
const TURN_SETTLE_POLL_INTERVAL_MS = 2_000;

/**
 * How long a not-busy status must hold before the turn counts as settled.
 *
 * A message delivered at a loop boundary (the prompt itself, or a mid-turn
 * injection) can start a fresh loop right as the previous one goes idle; the
 * engine reports busy again within milliseconds when that happens (verified
 * with `scripts/probe/opencode-async-probe.mjs`), so a stable-idle check is
 * what tells a real turn end from that hand-over.
 */
const TURN_SETTLE_CONFIRM_MS = 600;

/**
 * Ceiling on how long a run's tail keeps waiting for injected messages to be
 * answered (see `drainOpenCodeRun`). Injected turns normally settle long
 * before it; it only bounds a message the engine accepted but never ran, or
 * one left pending when the server died mid-drain.
 */
const DRAIN_INJECTION_WAIT_CEILING_MS = 10 * 60_000;

/** Silence after which a still-busy turn logs one stall warning (never fails it). */
const TURN_STALL_WARN_MS = 30 * 60_000;

/** Waits `ms`, for the polling loops above. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kills a spawned CLI process and everything it started.
 *
 * `cross-spawn` resolves `opencode` through the Windows `.cmd` shim, so the
 * handle it hands back is cmd.exe: killing that leaves the real opencode.exe
 * (and any server it hosts) running, holding the port and the project
 * instance. `taskkill /T` walks the whole tree; POSIX children take the
 * signal directly.
 */
function killProcessTree(child) {
  if (!child) {
    return;
  }

  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch {
      // Fall through to the plain kill.
    }
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
}

function readEventSessionId(event) {
  return readOptionalString(event.properties.sessionID);
}

function readEventToolCallId(event) {
  return readOptionalString(readObjectRecord(event.properties.tool)?.callID);
}

/**
 * Splits the catalog's `<providerID>/<modelID>` value into the two halves the
 * OpenCode server expects. The model id may itself contain slashes (e.g.
 * `openrouter/anthropic/claude-3`), so only the first separator is consumed.
 */
function splitProviderModel(resolvedModel) {
  if (!resolvedModel || typeof resolvedModel !== 'string') {
    return null;
  }

  const separator = resolvedModel.indexOf('/');
  if (separator <= 0 || separator === resolvedModel.length - 1) {
    return null;
  }

  return {
    providerId: resolvedModel.slice(0, separator),
    modelId: resolvedModel.slice(separator + 1),
  };
}

function readOpenCodeTokenUsage(sessionId) {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return readOpenCodeContextUsage(db, sessionId) || null;
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * Decides whether a dropped delivery should fail the run or keep waiting.
 *
 * A prompt can be lost to the client (dropped socket, a failed async accept)
 * while the engine keeps executing. When the session is still busy/retrying,
 * wait for it to settle so the run finishes normally instead of surfacing a
 * spurious transport error; the wait is health-driven and has no deadline,
 * because turns legitimately run for hours and a client-side cap only ever
 * produced false failures for work the engine was still doing. Returns false
 * when the server is unreachable or the session is already done, so the
 * caller can fail the run for real. Consumers: the failure paths of
 * `spawnOpenCode` and `injectOpenCodeInput`.
 */
async function resumeOpenCodeRun(run, workingDir) {
  if (!run.providerSessionId) {
    return false;
  }

  try {
    const status = await getOpenCodeSessionStatus(run.handle, workingDir, run.providerSessionId);
    if (status !== 'busy' && status !== 'retry') {
      return false;
    }
    await awaitOpenCodeTurnSettled(run, workingDir);
    return true;
  } catch (error) {
    console.warn('[OpenCode] Could not confirm the dropped turn is still running:', error);
    return false;
  }
}

/**
 * Builds the text part for one user message. Attachments ride along as
 * <images_input>/<files_input> path lists appended to the prompt; the session
 * history reader strips the tags back out. The text must stay newline-free for
 * the Windows shim.
 */
function buildOpenCodePrompt(command, images, files) {
  const hasAttachments =
    normalizeAttachmentDescriptors(images).length > 0
    || normalizeAttachmentDescriptors(files).length > 0;
  const prompt = (command && command.trim()) || hasAttachments
    ? appendFilesInputTag(appendImagesInputTag(command?.trim() || '', images), files)
    : '';
  return flattenPromptForWindowsShell(prompt);
}

/**
 * Waits until every message injected into the run has been answered.
 *
 * Each injected `POST /session/:id/message` resolves only when the prompt loop
 * that absorbed it goes idle, so this also covers a message that landed just
 * after the original turn's loop finished and started a loop of its own. More
 * injections can arrive while waiting, hence the loop.
 */
async function settleOpenCodeInjections(run) {
  while (run.injections.size > 0) {
    await Promise.allSettled(Array.from(run.injections));
  }
}

/**
 * Records the engine's busy/idle transitions for the run's own session.
 *
 * `session.idle` (and `session.status` idle) is the last event a prompt loop
 * emits on the ordered `/global/event` stream, after its final deltas and
 * completed parts. Consumers: `spawnOpenCode`'s event handler, and tests.
 */
export function trackOpenCodeSessionIdle(run, event) {
  let idle;
  if (event.type === 'session.idle') {
    idle = true;
  } else if (event.type === 'session.status') {
    const status = readOptionalString(readObjectRecord(event.properties.status)?.type);
    if (status !== 'idle' && status !== 'busy' && status !== 'retry') {
      return;
    }
    idle = status === 'idle';
  } else {
    return;
  }

  run.engineIdle = idle;
  if (idle) {
    for (const wake of Array.from(run.idleWaiters)) {
      wake();
    }
  }
}

/** Resolves once the run's session reports idle, or after `timeoutMs` at the latest. */
function waitForOpenCodeIdleEvent(run, timeoutMs) {
  if (run.engineIdle || run.aborted || timeoutMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      run.idleWaiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, timeoutMs);
    run.idleWaiters.add(wake);
  });
}

/** Reads whether the engine still lists the session as running; false when it cannot be read. */
async function openCodeSessionIsBusy(run) {
  try {
    const status = await getOpenCodeSessionStatus(run.handle, run.directory, run.providerSessionId);
    return status === 'busy' || status === 'retry';
  } catch {
    return false;
  }
}

/**
 * Registers one async-injected message as pending the engine's answer.
 *
 * The tracked promise resolves when the settle logic has confirmed the engine
 * idle after this message was accepted (`noteOpenCodeIdleObserved`) — the
 * async equivalent of the blocking request resolving when its loop goes idle.
 * Consumers: `injectOpenCodeInput`.
 */
function registerOpenCodeInjection(run, acceptedAt) {
  let resolveTracked = () => {};
  const accepted = new Promise((resolve) => {
    resolveTracked = resolve;
  });
  const tracked = accepted.finally(() => {
    run.injections.delete(tracked);
    run.pendingInjectionAnswers.delete(tracked);
  });
  run.injections.add(tracked);
  run.pendingInjectionAnswers.set(tracked, { acceptedAt, resolve: resolveTracked });
}

/** Releases every pending async injection; nothing will answer a stopped turn. */
function forceResolveOpenCodeInjections(run) {
  if (!run.pendingInjectionAnswers) {
    return;
  }
  for (const record of Array.from(run.pendingInjectionAnswers.values())) {
    record.resolve();
  }
}

/** Releases async injections accepted before `observedAt`. */
function resolveOpenCodeInjectionsAnsweredBefore(run, observedAt) {
  for (const [tracked, record] of Array.from(run.pendingInjectionAnswers)) {
    if (record.acceptedAt <= observedAt) {
      record.resolve();
    }
  }
}

/**
 * Confirms an observed idle really is the engine settling, not a loop
 * hand-over: a message accepted at the boundary is picked up by a fresh loop
 * within milliseconds, and the busy status that starts it is the proof it
 * happened. When the idle holds, injections accepted before the observation
 * are released as answered (the loops that ended had read them).
 *
 * Returns true on settled idle, false when a fresh loop took over (the
 * caller keeps waiting). Throws only when the status read fails and the
 * server is unreachable, so the caller surfaces a real failure.
 * Consumers: `awaitOpenCodeTurnSettled` and `noteOpenCodeIdleObserved`.
 */
async function confirmOpenCodeSettledIdle(run, workingDir, observedAt) {
  await sleep(TURN_SETTLE_CONFIRM_MS);
  if (run.aborted || run.terminal) {
    return false;
  }

  let status;
  try {
    status = await getOpenCodeSessionStatus(run.handle, workingDir, run.providerSessionId);
  } catch (error) {
    if (await isOpenCodeServerReachable(run.handle)) {
      return false;
    }
    throw error;
  }

  if (status === 'busy' || status === 'retry') {
    run.engineIdle = false;
    return false;
  }

  resolveOpenCodeInjectionsAnsweredBefore(run, observedAt);
  return true;
}

/**
 * Runs on every idle observation made through the event stream.
 *
 * This is what releases messages injected after the settle loop finished but
 * while the run still drains (their turns stream through this run). Single
 * flight, because `session.idle` and `session.status` often arrive together.
 * Failures are swallowed: the settle loop (or a later idle observation) owns
 * them. Consumers: `spawnOpenCode`'s event handler.
 */
function noteOpenCodeIdleObserved(run) {
  if (run.aborted || run.terminal || run.pendingInjectionAnswers.size === 0 || run.injectionSettlePromise) {
    return;
  }
  run.injectionSettlePromise = (async () => {
    try {
      let observedAt = Date.now();
      for (;;) {
        if (!(await confirmOpenCodeSettledIdle(run, run.directory, observedAt))) {
          return;
        }
        if (run.pendingInjectionAnswers.size === 0) {
          return;
        }
        // Messages accepted during the grace period were not read by the
        // loops that already ended; if the engine holds idle they are
        // released on the next round, otherwise the busy check above keeps
        // the wait alive.
        observedAt = Date.now();
      }
    } catch {
      // The run's own wait or the next idle observation handles real failures.
    }
  })().finally(() => {
    run.injectionSettlePromise = null;
  });
}

/** Logs once per stall window when the engine reports busy with no events at all. */
function maybeWarnOpenCodeTurnStall(run) {
  const now = Date.now();
  if (now - run.lastEventAt < TURN_STALL_WARN_MS || now - run.stallWarnedAt < TURN_STALL_WARN_MS) {
    return;
  }
  run.stallWarnedAt = now;
  console.warn(
    `[OpenCode] Turn ${run.providerSessionId || run.runId} has reported busy for ${Math.round((now - run.lastEventAt) / 60_000)} minutes with no events; still waiting.`,
  );
}

/**
 * Waits until the engine has finished the turn this run is driving.
 *
 * The engine is the authority on turn state, so the loop ends on a
 * confirmed-settled idle and throws only when the server is unreachable (its
 * work is gone; the caller fails the run for real). Idle events wake it early;
 * the status poll is the fallback that survives stream gaps. There is no
 * deadline: a server that answers its health probe is allowed to keep working,
 * however long the turn takes. Consumers: `spawnOpenCode`'s async path and
 * `resumeOpenCodeRun`.
 */
async function awaitOpenCodeTurnSettled(run, workingDir) {
  for (;;) {
    if (run.aborted || run.terminal) {
      return;
    }

    if (!run.engineIdle) {
      await waitForOpenCodeIdleEvent(run, TURN_SETTLE_POLL_INTERVAL_MS);
      if (run.aborted || run.terminal) {
        return;
      }
      if (!run.engineIdle) {
        let status;
        try {
          status = await getOpenCodeSessionStatus(run.handle, workingDir, run.providerSessionId);
        } catch (error) {
          if (await isOpenCodeServerReachable(run.handle)) {
            maybeWarnOpenCodeTurnStall(run);
            continue;
          }
          throw error;
        }
        if (status === 'busy' || status === 'retry') {
          maybeWarnOpenCodeTurnStall(run);
          continue;
        }
        run.engineIdle = true;
        run.lastIdleObservedAt = Date.now();
      }
    }

    const observedAt = Date.now();
    if (await confirmOpenCodeSettledIdle(run, workingDir, observedAt)) {
      if (run.injections.size === 0) {
        return;
      }
      // Injections accepted during the grace period stay pending until the
      // loops answering them settle; keep waiting.
    }
  }
}

/**
 * Watches a freshly accepted async prompt for any sign of life.
 *
 * `prompt_async` answering 204 only means the message was enqueued — the
 * engine accepts even prompts it is about to reject (an unknown model rides
 * on a `session.error` event, verified with the probe). A turn that actually
 * ran is proven by a busy status, a session error, or an idle observed after
 * acceptance (an ultra-fast turn can finish before the first poll). Nothing
 * within the window means the engine dropped the prompt, which must surface
 * as a real failure instead of a silently empty turn. Throws when the server
 * goes away mid-check, so the caller reports the transport failure.
 * Consumers: `deliverOpenCodePrompt`.
 */
async function confirmOpenCodePromptStarted(run, workingDir) {
  const startTimeoutMs = Number(process.env.OPENCODE_PROMPT_START_TIMEOUT_MS) || PROMPT_START_TIMEOUT_DEFAULT_MS;
  const deadline = Date.now() + startTimeoutMs;
  for (;;) {
    if (run.aborted || run.terminal) {
      return true;
    }
    if (run.sawSessionError || run.lastIdleObservedAt >= run.promptAcceptedAt) {
      return true;
    }

    let status = null;
    let probeFailed = false;
    try {
      status = await getOpenCodeSessionStatus(run.handle, workingDir, run.providerSessionId);
    } catch (error) {
      probeFailed = true;
      if (!(await isOpenCodeServerReachable(run.handle))) {
        throw error;
      }
    }

    if (!probeFailed && (status === 'busy' || status === 'retry')) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(PROMPT_START_POLL_INTERVAL_MS);
  }
}

/**
 * Delivers the run's prompt, preferring the async endpoint.
 *
 * The async send resolves on acceptance (204) and the caller then watches the
 * engine for the turn itself; engines whose server predates `prompt_async`
 * fall back to the blocking send, whose response is the old turn-end signal.
 * The mode is recorded on the run so the completion path knows which
 * lifecycle applies. Consumers: `spawnOpenCode`.
 */
async function deliverOpenCodePrompt(run, workingDir, input) {
  if (openCodeServerSupportsAsyncPrompt(run.handle)) {
    try {
      await sendOpenCodeMessageAsync(run.handle, workingDir, run.providerSessionId, input);
      run.sendMode = 'async';
      run.promptAcceptedAt = Date.now();
      if (await confirmOpenCodePromptStarted(run, workingDir)) {
        return;
      }
      throw new Error('OpenCode accepted the prompt but the turn never started; the engine may have dropped it.');
    } catch (error) {
      if (!isOpenCodeAsyncPromptUnsupportedError(error)) {
        throw error;
      }
      // Endpoint missing on this engine: use the blocking send below.
    }
  }

  run.sendMode = 'blocking';
  await sendOpenCodeMessage(run.handle, workingDir, run.providerSessionId, input);
}

/**
 * Holds the run open until its turn has fully played out on the event stream.
 *
 * Once the settle loop (or the blocking send) is done, the stream may still
 * carry the turn's tail (final deltas, the completed part, `session.idle`),
 * and messages injected meanwhile must be answered by loops whose output
 * streams through this run. The loop repeats while injections exist; the
 * injection ceiling and stopped runs release whatever cannot be answered, so
 * the drain cannot hang on a dead server. The loop exits on a synchronous
 * check, so the caller's cleanup runs with no await in between and no
 * injection slips in unobserved. Consumers: `spawnOpenCode`'s `finally`, and
 * tests.
 */
export async function drainOpenCodeRun(run, idleTimeoutMs = RUN_IDLE_EVENT_TIMEOUT_MS) {
  const injectionDeadline = Date.now() + DRAIN_INJECTION_WAIT_CEILING_MS;
  do {
    if (run.aborted || run.terminal || Date.now() >= injectionDeadline) {
      // A stopped (or over-deadline) turn takes no more messages, so nothing
      // will answer the pending ones; release them so the drain ends.
      forceResolveOpenCodeInjections(run);
    }
    await settleOpenCodeInjections(run);
    await waitForOpenCodeIdleEvent(run, idleTimeoutMs);
  } while (run.injections.size > 0);
}

/**
 * Decides whether a finished turn must be resumed once to rescue its work.
 *
 * Two shapes of the same failure: a subagent (task) part completed with an
 * empty `<task_result>` — the subagent's response was cut off at the output
 * limit before it delivered — or the turn itself ended with no assistant text
 * and no tool call, the same truncation hitting the parent. The engine reports
 * both as success, so without this the run ends green having delivered
 * nothing; with it the runtime re-prompts once (see
 * `buildOpenCodeResumeMessage`).
 *
 * A run the user aborted or that truly failed is never resumed, and the
 * one-attempt flag (`emptyResultResumeAttempt` on the run options) caps the
 * rescue so a model that truncates every response cannot loop.
 * Consumed by `spawnOpenCode`'s completion path.
 */
export function shouldResumeOpenCodeTurn({
  hasPrompt,
  aborted,
  failed,
  attempted,
  emptyDeliveries,
  toolPartCount,
  sawAssistantText,
}) {
  if (!hasPrompt || aborted || failed || attempted) {
    return false;
  }

  if (Array.isArray(emptyDeliveries) && emptyDeliveries.length > 0) {
    return true;
  }

  return toolPartCount === 0 && !sawAssistantText;
}

/**
 * Builds the one user message that resumes a turn whose work never landed.
 *
 * The empty attempt never reported complete, so the resumed turn's output
 * streams into the same client turn. The message is persisted like any user
 * input, which is why it reads as an explicit system-level retry and names
 * the empty subagent — the parent should continue it through `task_id`
 * instead of redoing the work from scratch.
 * Consumed by `spawnOpenCode`'s completion path.
 */
export function buildOpenCodeResumeMessage({ emptyDeliveries }) {
  const deliveries = Array.isArray(emptyDeliveries) ? emptyDeliveries : [];
  if (deliveries.length === 0) {
    return '[cloudcli auto-retry] The previous response ended without any output — no text and no tool calls were produced. '
      + 'It was most likely cut off at the output limit. Continue the task from where it stopped and produce the deliverables.';
  }

  const named = deliveries.slice(0, 3).map((delivery) => {
    const description = readOptionalString(delivery?.description);
    const taskId = readOptionalString(delivery?.taskId);
    return `${description ? `"${description}"` : 'subagent task'}${taskId ? ` (task_id ${taskId})` : ''}`;
  });
  const overflow = deliveries.length > named.length ? ` and ${deliveries.length - named.length} more` : '';
  const pronoun = deliveries.length > 1 ? 'each one via its task_id' : 'it via its task_id';
  return `[cloudcli auto-retry] This subagent run finished with an empty result and delivered nothing: ${named.join('; ')}${overflow}. `
    + `Resume ${pronoun} and have it finish the original task, then verify the deliverables actually exist before reporting back.`;
}

/**
 * Runs one OpenCode turn against the shared `opencode serve` instance.
 *
 * The CLI's `run` mode cannot surface tool approvals (it auto-rejects every
 * `ask` rule), so the runtime drives the server's own session/message API and
 * consumes its event stream instead. Live output is normalized through the same
 * `sessions` provider as history, and `permission.asked`/`question.asked`
 * events become approval cards through the permissions bridge.
 */
async function spawnOpenCode(command, options = {}, ws, context) {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    effort,
    sessionSummary,
    images,
    files,
    permissionMode
  } = options;
  // Callers pass the stable app session id; the server resumes with the
  // provider-native id recorded on the session row. A resume launched by this
  // function itself passes the native id explicitly, because the session row
  // may not carry it yet when the rescue turn starts.
  const providerSessionId = options.providerSessionId || context.resolveProviderSessionId(sessionId);
  const workingDir = cwd || projectPath || process.cwd();
  const runId = sessionId || `opencode-${Date.now()}`;
  const promptText = buildOpenCodePrompt(command, images, files);

  let effortModels = null;
  try {
    effortModels = await context.getProviderModels();
  } catch (error) {
    console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
  }

  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  const resolvedEffort = resolveModelEffort(resolvedModel, effort, effortModels);
  const parsedModel = splitProviderModel(resolvedModel);
  const agent = resolveOpenCodeAgent(permissionMode);

  const handle = await acquireOpenCodeServer();

  const run = {
    runId,
    appSessionId: sessionId || null,
    providerSessionId: providerSessionId || '',
    directory: workingDir,
    handle,
    writer: ws,
    permissionMode,
    /** What this turn runs with; a message injected mid-turn reuses it. */
    model: parsedModel,
    agent,
    variant: resolvedEffort || undefined,
    /** Pending requests of messages injected into this turn (see `injectOpenCodeInput`). */
    injections: new Set(),
    /** Async injections awaiting an idle confirmation, keyed by their tracked promise. */
    pendingInjectionAnswers: new Map(),
    /** In-flight single-flight settle pass started by an idle observation (see `noteOpenCodeIdleObserved`). */
    injectionSettlePromise: null,
    /** Whether the stream last reported the session idle, and who waits for it (see `drainOpenCodeRun`). */
    engineIdle: false,
    idleWaiters: new Set(),
    aborted: false,
    completeSent: false,
    /** True once the run takes no more messages (failure or cleanup; see `injectOpenCodeInput`). */
    terminal: false,
    /** 'async' | 'blocking': which delivery lifecycle this run uses (see `deliverOpenCodePrompt`). */
    sendMode: null,
    /** When the async accept landed, and when an idle was last observed (any path). */
    promptAcceptedAt: 0,
    lastIdleObservedAt: 0,
    /** Set when the engine reported a session.error for this turn. */
    sawSessionError: false,
    /** Timestamp of the newest event of any session, for the stall warning. */
    lastEventAt: Date.now(),
    stallWarnedAt: 0,
    terminalNotified: false,
    /** Timestamp of the last mid-turn context read, and the occupancy it published. */
    contextPublishedAt: 0,
    publishedContextUsed: null,
    userMessageIds: new Set(),
    assistantMessageIds: new Set(),
    partTypes: new Map(),
    deltaPartIds: new Set(),
    /** Empty subagent deliveries seen this turn (see `readOpenCodeTaskDelivery`), deduplicated by part id. */
    emptyDeliveries: [],
    emptyDeliveryPartIds: new Set(),
    /** Whether any main-thread assistant text streamed; an all-empty turn is a failure the run must rescue. */
    sawAssistantText: false,
    /** Distinct tool parts of this turn's own session, counted once per part id. */
    toolPartCount: 0,
  };

  const indexRun = () => {
    activeRuns.set(runId, run);
    if (run.providerSessionId) {
      activeRuns.set(run.providerSessionId, run);
    }
  };
  indexRun();
  registerOpenCodeRun(run);

  const notifyTerminalState = ({ error = null } = {}) => {
    if (run.terminalNotified) {
      return;
    }
    run.terminalNotified = true;

    const finalSessionId = run.appSessionId || run.providerSessionId || runId;
    if (!error) {
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: 'completed',
      });
      return;
    }

    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'opencode',
      sessionId: finalSessionId,
      sessionName: sessionSummary,
      error,
    });
  };

  const sendError = (content) => {
    ws.send(createNormalizedMessage({
      kind: 'error',
      content,
      sessionId: run.providerSessionId || run.appSessionId || null,
      provider: 'opencode',
    }));
  };

  const sendTokenBudget = (tokenBudget) => {
    ws.send(createNormalizedMessage({
      kind: 'status',
      text: 'token_budget',
      tokenBudget,
      sessionId: run.appSessionId || run.providerSessionId || runId,
      provider: 'opencode',
    }));
  };

  /**
   * Publishes the session's context occupancy while the turn is still running.
   *
   * OpenCode only reports usage when the whole run ends, so without this the
   * composer's context badge stayed frozen for the entire tool loop. Message
   * updates arrive as each step closes and its usage is persisted, so each one
   * re-reads opencode.db — rate-limited, and skipped when the occupancy has
   * not moved since the last frame. The payload is what `/token-usage`
   * returns, so the live badge and a reloaded transcript cannot disagree.
   */
  const publishLiveTokenBudget = () => {
    if (run.aborted || run.completeSent || !run.providerSessionId) {
      return;
    }

    const now = Date.now();
    if (now - run.contextPublishedAt < LIVE_CONTEXT_MIN_INTERVAL_MS) {
      return;
    }
    run.contextPublishedAt = now;

    const tokenBudget = readOpenCodeTokenUsage(run.providerSessionId);
    const used = Number(tokenBudget?.used ?? 0);
    if (!tokenBudget || used <= 0 || used === run.publishedContextUsed) {
      return;
    }

    run.publishedContextUsed = used;
    sendTokenBudget(tokenBudget);
  };

  const registerProviderSession = (nextSessionId) => {
    if (!nextSessionId || run.providerSessionId === nextSessionId) {
      return;
    }

    run.providerSessionId = nextSessionId;
    activeRuns.set(nextSessionId, run);

    if (ws.setSessionId && typeof ws.setSessionId === 'function') {
      ws.setSessionId(nextSessionId);
    }

    if (!providerSessionId) {
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: nextSessionId,
        sessionId: nextSessionId,
        provider: 'opencode',
      }));
    }
  };

  const emitNormalized = (raw) => {
    let normalized;
    try {
      normalized = context.normalizeMessage(raw, run.providerSessionId || run.appSessionId || null);
    } catch (error) {
      console.error('[OpenCode] Failed to normalize server event:', error);
      return;
    }

    for (const message of normalized) {
      ws.send(message);
    }
  };

  const handlePartUpdated = (event) => {
    const part = readObjectRecord(event.properties.part);
    if (!part) {
      return;
    }

    const partId = readOptionalString(part.id);
    const partType = readOptionalString(part.type);
    const messageId = readOptionalString(part.messageID);

    if (partId && partType) {
      const isFirstSighting = !run.partTypes.has(partId);
      run.partTypes.set(partId, partType);
      if (isFirstSighting && partType === 'tool') {
        run.toolPartCount += 1;
      }
    }

    if (messageId && run.userMessageIds.has(messageId)) {
      return;
    }

    // Text and reasoning only stream for the assistant message; tool and
    // step-finish parts are assistant-only by construction.
    const isContentPart = partType === 'text' || partType === 'reasoning';
    if (isContentPart && messageId && !run.assistantMessageIds.has(messageId)) {
      return;
    }

    if (partType === 'tool') {
      const delivery = readOpenCodeTaskDelivery(part);
      if (delivery?.empty && (!partId || !run.emptyDeliveryPartIds.has(partId))) {
        if (partId) {
          run.emptyDeliveryPartIds.add(partId);
        }
        run.emptyDeliveries.push(delivery);
      }
      emitNormalized({ type: 'tool_use', id: partId, sessionID: run.providerSessionId, part });
      return;
    }

    if (partType === 'step-finish') {
      emitNormalized({ type: 'step_finish', id: partId, sessionID: run.providerSessionId });
      // A step closing is the earliest point its usage can be read back, so
      // the composer's badge moves with the tool loop instead of at `complete`.
      publishLiveTokenBudget();
      return;
    }

    // Some turns deliver no `message.part.delta` for a text/reasoning part; fall
    // back to the completed part's full text so nothing is silently dropped.
    if ((partType === 'text' || partType === 'reasoning') && partId) {
      const time = readObjectRecord(part.time) ?? {};
      const completed = time.end !== undefined && time.end !== null;
      if (completed && !run.deltaPartIds.has(partId) && typeof part.text === 'string' && part.text.trim()) {
        if (partType === 'text') {
          run.sawAssistantText = true;
        }
        emitNormalized({ type: partType, id: partId, partID: partId, sessionID: run.providerSessionId, text: part.text, messageID: messageId });
      }
    }
  };

  const handlePartDelta = (event) => {
    const partId = readOptionalString(event.properties.partID);
    const messageId = readOptionalString(event.properties.messageID);
    const field = readOptionalString(event.properties.field);
    const delta = typeof event.properties.delta === 'string' ? event.properties.delta : '';

    if (!partId || !delta || field !== 'text') {
      return;
    }

    if (messageId && run.userMessageIds.has(messageId)) {
      return;
    }
    if (messageId && !run.assistantMessageIds.has(messageId)) {
      return;
    }

    run.deltaPartIds.add(partId);
    const kind = run.partTypes.get(partId) === 'reasoning' ? 'reasoning' : 'text';
    if (kind === 'text' && delta.trim().length > 0) {
      run.sawAssistantText = true;
    }
    // `partID` is what the persisted row is reconciled through: the streamed
    // text has no row id of its own, so the part is the identity both paths
    // share (see buildOpenCodeTextRowKey).
    emitNormalized({ type: kind, id: partId, partID: partId, sessionID: run.providerSessionId, text: delta, messageID: messageId });
  };

  const handleMessageUpdated = (event) => {
    const info = readObjectRecord(event.properties.info);
    const role = readOptionalString(info?.role);
    const id = readOptionalString(info?.id);
    if (!id) {
      return;
    }
    if (role === 'user') {
      run.userMessageIds.add(id);
    } else if (role === 'assistant') {
      run.assistantMessageIds.add(id);
      // Each step's usage lands with its message update; refresh the badge
      // without waiting for the whole run to finish.
      publishLiveTokenBudget();
    }
  };

  // Approval events never reach this switch: they are routed through the
  // permissions bridge first, which also re-attributes subagent (child
  // session) requests to this run.
  const handleRunEvent = (event) => {
    switch (event.type) {
      case 'message.part.updated':
        handlePartUpdated(event);
        return;
      case 'message.part.delta':
        handlePartDelta(event);
        return;
      case 'message.updated':
        handleMessageUpdated(event);
        return;
      case 'session.idle':
      case 'session.status':
        trackOpenCodeSessionIdle(run, event);
        if (run.engineIdle) {
          run.lastIdleObservedAt = Date.now();
          noteOpenCodeIdleObserved(run);
        }
        return;
      case 'session.error': {
        run.sawSessionError = true;
        const errorRecord = readObjectRecord(event.properties.error) ?? {};
        const message = readOptionalString(readObjectRecord(errorRecord.data)?.message)
          ?? readOptionalString(errorRecord.message)
          ?? readOptionalString(errorRecord.name)
          ?? 'OpenCode reported an error';
        sendError(message);
        return;
      }
      default:
        return;
    }
  };

  const unsubscribe = subscribeOpenCodeEvents((event) => {
    // Any event proves the shared engine is alive; the stall warning is about
    // a server that went entirely quiet, not just this session.
    run.lastEventAt = Date.now();

    if (!run.providerSessionId) {
      return;
    }

    if (isOpenCodeApprovalEvent(event.type)) {
      try {
        handleOpenCodeApprovalEvent(run, event);
      } catch (error) {
        console.error('[OpenCode] Failed to handle approval event:', error);
      }
      return;
    }

    if (readEventSessionId(event) !== run.providerSessionId) {
      return;
    }
    try {
      handleRunEvent(event);
    } catch (error) {
      console.error('[OpenCode] Failed to handle server event:', error);
    }
  });

  let failure = null;
  // Set when the turn delivered nothing and the completion path will resume it
  // once (see `shouldResumeOpenCodeTurn`).
  let pendingResume = false;

  try {
    if (!run.providerSessionId) {
      const createdSessionId = await createOpenCodeSession(handle, workingDir, parsedModel, agent);
      registerProviderSession(createdSessionId);
    }

    await deliverOpenCodePrompt(run, workingDir, {
      text: promptText,
      model: run.model,
      agent: run.agent,
      variant: run.variant,
    });

    if (run.sendMode === 'async') {
      // Delivery only proved acceptance; the engine remains the authority on
      // the turn itself. This wait ends when the engine settles — or throws
      // when the server is gone, which fails the run for real below.
      await awaitOpenCodeTurnSettled(run, workingDir);
    }
  } catch (error) {
    if (!run.aborted) {
      // A dropped delivery does not mean the turn died: the engine often
      // keeps going. Only fail the run when it truly is not running anymore.
      const resumed = await resumeOpenCodeRun(run, workingDir);
      if (!resumed) {
        failure = error;
        const installed = await context.isProviderInstalled();
        const content = !installed
          ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/'
          : (error instanceof Error ? error.message : String(error));
        sendError(content);
      }
    }
  } finally {
    // The turn is not over until messages injected into it are answered and
    // its last events have streamed: their output goes through this run, and
    // its `complete` ends them. A failed turn takes no more messages and has
    // no tail left to wait for. Nothing awaits between the drain's last
    // injection check and the cleanup below, so no injection can slip in
    // unobserved.
    if (failure) {
      run.terminal = true;
    }
    await drainOpenCodeRun(run, failure ? 0 : RUN_IDLE_EVENT_TIMEOUT_MS);
    // From here on the run takes no more messages: `injectOpenCodeInput`
    // either lands fully before this point or starts a fresh run.
    run.terminal = true;
    unsubscribe();
    unregisterOpenCodeRun(runId);
    activeRuns.delete(runId);
    if (run.providerSessionId) {
      activeRuns.delete(run.providerSessionId);
    }
    releaseOpenCodeServer();

    if (!run.aborted && !run.completeSent) {
      run.completeSent = true;
      // A turn that delivered nothing (an empty subagent result, or an empty
      // whole turn) must not report complete: the rescue turn below streams
      // into the same client turn and sends the only terminal frame.
      pendingResume = shouldResumeOpenCodeTurn({
        hasPrompt: promptText.length > 0,
        aborted: run.aborted,
        failed: Boolean(failure),
        attempted: Boolean(options.emptyResultResumeAttempt),
        emptyDeliveries: run.emptyDeliveries,
        toolPartCount: run.toolPartCount,
        sawAssistantText: run.sawAssistantText,
      });

      if (!pendingResume) {
        const tokenBudget = readOpenCodeTokenUsage(run.providerSessionId);
        if (tokenBudget) {
          sendTokenBudget(tokenBudget);
        }

        ws.send(createCompleteMessage({
          provider: 'opencode',
          sessionId: run.appSessionId || run.providerSessionId || runId,
          actualSessionId: run.providerSessionId || undefined,
          exitCode: failure ? 1 : 0,
        }));
        notifyTerminalState({ error: failure });
      }
    }
  }

  if (failure) {
    throw failure;
  }

  if (pendingResume) {
    console.log(
      `[OpenCode] Turn ${run.providerSessionId || runId} delivered no result; resuming once with an auto-retry message`
    );
    return spawnOpenCode(
      buildOpenCodeResumeMessage({ emptyDeliveries: run.emptyDeliveries }),
      {
        ...options,
        // The retry carries no new attachments; originals were already sent.
        images: undefined,
        files: undefined,
        providerSessionId: run.providerSessionId || options.providerSessionId,
        emptyResultResumeAttempt: true,
      },
      ws,
      context,
    );
  }
}

/**
 * Cancels the run for one session. The chat gateway emits the terminal
 * `complete` on the aborted run's behalf, so this only stops the engine.
 */
async function abortOpenCodeSession(sessionId) {
  const run = activeRuns.get(sessionId);
  if (!run) {
    return false;
  }

  run.aborted = true;
  if (run.providerSessionId) {
    await abortOpenCodeServerSession(run.handle, run.directory, run.providerSessionId);
  }
  return true;
}

/**
 * Feeds a user message into the session's running turn.
 *
 * OpenCode's prompt loop re-reads the conversation after every step, so a
 * message posted while the session is busy is answered once the current step
 * ends — a running tool or subagent is not interrupted (verified with
 * scripts/probe/opencode-midturn-probe.mjs for the blocking send and
 * scripts/probe/opencode-async-probe.mjs for the async one). The message
 * reuses the turn's model, agent and effort, its output streams through the
 * run's writer, and the run does not complete before it is answered: the
 * async send registers a pending answer that the settle logic releases once
 * the engine is confirmed idle after acceptance, while the blocking fallback
 * resolves when its own request returns. Resolves false when there is no live
 * turn left to take it.
 */
async function injectOpenCodeInput(command, options = {}) {
  const run = activeRuns.get(options.sessionId);
  if (!run || run.aborted || run.terminal || run.completeSent || !run.providerSessionId) {
    return false;
  }

  const input = {
    text: buildOpenCodePrompt(command, options.images, options.files),
    model: run.model,
    agent: run.agent,
    variant: run.variant,
  };

  if (openCodeServerSupportsAsyncPrompt(run.handle)) {
    let accepted = false;
    try {
      await sendOpenCodeMessageAsync(run.handle, run.directory, run.providerSessionId, input);
      accepted = true;
    } catch (error) {
      if (!isOpenCodeAsyncPromptUnsupportedError(error)) {
        // As with the turn's own prompt, a dropped socket does not mean the
        // engine lost the message; only report it when the session stopped.
        if (await openCodeSessionIsBusy(run)) {
          accepted = true;
        } else {
          const reason = error instanceof Error ? error.message : String(error);
          console.error('[OpenCode] Mid-turn message was not delivered:', reason);
          run.writer.send(createNormalizedMessage({
            kind: 'error',
            content: `OpenCode did not take the message sent during the turn: ${reason}`,
            sessionId: run.providerSessionId || run.appSessionId || null,
            provider: 'opencode',
          }));
          return true;
        }
      }
      // The unsupported marker falls through to the blocking endpoint below.
    }

    if (accepted) {
      // Registered synchronously after acceptance: the run's cleanup only
      // starts once `injections` is empty, so this message cannot be orphaned.
      registerOpenCodeInjection(run, Date.now());
      // An idle seen earlier no longer ends the turn: the loop that answers
      // this message reports its own idle once its output has streamed.
      run.engineIdle = false;
      return true;
    }
  }

  // Legacy blocking send: its response is the "answered" signal.
  const tracked = sendOpenCodeMessage(run.handle, run.directory, run.providerSessionId, input)
    .catch(async (error) => {
      if (run.aborted) {
        return;
      }
      // As with the turn's own prompt, a dropped socket does not mean the
      // engine lost the message; only report it when the session stopped.
      if (await resumeOpenCodeRun(run, run.directory)) {
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[OpenCode] Mid-turn message was not delivered:', reason);
      run.writer.send(createNormalizedMessage({
        kind: 'error',
        content: `OpenCode did not take the message sent during the turn: ${reason}`,
        sessionId: run.providerSessionId || run.appSessionId || null,
        provider: 'opencode',
      }));
    })
    .finally(() => {
      run.injections.delete(tracked);
    });
  run.injections.add(tracked);
  // An idle seen earlier no longer ends the turn: the loop that answers this
  // message reports its own idle once its output has streamed.
  run.engineIdle = false;
  return true;
}

function isOpenCodeSessionActive(sessionId) {
  return activeRuns.has(sessionId);
}

function getActiveOpenCodeSessions() {
  return Array.from(new Set(Array.from(activeRuns.values()).map((run) => run.runId)));
}

/**
 * Compacts a stored OpenCode conversation in place.
 *
 * The shared server exposes the primitive the TUI itself uses:
 * `POST /session/:id/summarize`. This spawns a short-lived headless server,
 * calls that endpoint with the session's own model, and tears the server down.
 * The endpoint runs OpenCode's whole compaction loop, so the next history
 * refresh shows the summary.
 */
function readOpenCodeSessionModel(sessionId) {
  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT model FROM session WHERE id = ?').get(sessionId);
    if (!row || typeof row.model !== 'string') {
      return null;
    }

    const parsed = JSON.parse(row.model);
    const providerId = typeof parsed?.providerID === 'string' ? parsed.providerID : null;
    const modelId = typeof parsed?.id === 'string' ? parsed.id : null;
    return providerId && modelId ? { providerId, modelId } : null;
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/** Picks a free loopback port for the short-lived compaction server. */
function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
          return;
        }
        reject(new Error('Could not reserve a loopback port for OpenCode compaction.'));
      });
    });
  });
}

/** Basic-auth header for `opencode serve` when the user secured it. */
function openCodeServerAuthHeaders() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    return {};
  }

  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

const COMPACT_SERVER_READY_TIMEOUT_MS = 20_000;
// A summarize of a large context can outlive undici's default five-minute
// transport cap; the shared openCodeFetch agent carries the request instead.
const COMPACT_REQUEST_TIMEOUT_MS = 30 * 60_000;

async function waitForOpenCodeServer(baseUrl, headers, serverProcess) {
  const deadline = Date.now() + COMPACT_SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`OpenCode server exited before it was ready (code ${serverProcess.exitCode}).`);
    }

    try {
      const response = await openCodeFetch(`${baseUrl}/config`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('OpenCode server did not become ready in time.');
}

async function compactOpenCodeSession(options = {}, ws, context) {
  const { sessionId } = options;
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  if (!sessionId || !providerSessionId) {
    throw new Error('This OpenCode session has no stored conversation to compact yet.');
  }

  const model = readOpenCodeSessionModel(providerSessionId);
  if (!model) {
    throw new Error('OpenCode did not report a model for this session, so it cannot be compacted.');
  }

  const workingDir = options.cwd || options.projectPath || process.cwd();
  ws.send(createNormalizedMessage({
    kind: 'status',
    text: 'Compacting context…',
    canInterrupt: false,
    sessionId,
    provider: 'opencode',
  }));

  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', ...openCodeServerAuthHeaders() };
  const serverProcess = spawnFunction('opencode', ['serve', '--port', String(port)], {
    cwd: workingDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });

  let stderrTail = '';
  serverProcess.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-1000);
  });
  // The server's stdout is noise for this one request; drain it so the pipe
  // never back-pressures the child.
  serverProcess.stdout?.on('data', () => {});

  try {
    await waitForOpenCodeServer(baseUrl, headers, serverProcess);

    const response = await openCodeFetch(`${baseUrl}/session/${encodeURIComponent(providerSessionId)}/summarize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerID: model.providerId, modelID: model.modelId, auto: false }),
      signal: AbortSignal.timeout(COMPACT_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const suffix = detail.trim() ? `: ${detail.trim().slice(0, 300)}` : '';
      throw new Error(`OpenCode refused to compact this session (HTTP ${response.status})${suffix}`);
    }

    return true;
  } catch (error) {
    if (stderrTail.trim()) {
      console.warn(`[OpenCode] Compaction server stderr: ${stderrTail.trim().split('\n').slice(-1)[0]}`);
    }
    throw error;
  } finally {
    killProcessTree(serverProcess);
  }
}

export const opencodeRuntime = {
  run: spawnOpenCode,
  abort: abortOpenCodeSession,
  compact: compactOpenCodeSession,
  injectInput: injectOpenCodeInput,
  permissions: openCodePermissions,
};

export {
  spawnOpenCode,
  abortOpenCodeSession,
  injectOpenCodeInput,
  compactOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
};

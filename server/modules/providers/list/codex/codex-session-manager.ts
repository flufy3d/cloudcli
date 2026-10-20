/**
 * Resident Codex sessions
 * =======================
 *
 * A resident session is one `codex app-server` process that outlives a single
 * turn, so the next round of the same app session continues in the same native
 * thread instead of paying a process start and a history reload.
 *
 * ## Why the round is submitted through the engine's queue
 *
 * `turn/start` cannot start a second turn on a thread that already has one:
 * the server steers the running turn instead, which merges the new input into
 * whatever the engine was already doing. A background report the engine starts
 * on its own would therefore swallow the user's message. The engine's thread
 * queue has no such problem — it refuses to start while a turn is active and
 * starts each queued input as its own turn once the thread is idle — so a
 * round is submitted by writing to the queue and letting the engine drain it.
 *
 * ## Which turn belongs to a round
 *
 * The engine consumes a queued item *before* it reports the turn that item
 * produced, and it reports the consumption as `thread/queue/changed`. A round
 * is therefore armed once its queued item is gone from the queue, and the
 * first `turn/started` after that is the round's turn. A turn the engine
 * started on its own consumes nothing, so it never arms a round and is
 * reported as engine work.
 *
 * Consumers: `codex-runtime.provider.ts` (the Codex chat runtime) borrows a
 * resident session per app session and submits its rounds through it.
 */

import { randomUUID } from 'node:crypto';

import {
  codexAppServerTransport,
  type CodexAppServerConnection,
  type CodexAppServerHandlers,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { AnyRecord } from '@/shared/index.js';

/** How long a resident process may sit idle before it is reclaimed. */
const RESIDENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** How many app sessions may hold a resident process at the same time. */
const RESIDENT_MAX_SESSIONS = 4;

/**
 * The reclaim window of an idle resident process.
 *
 * A resident process keeps the engine, its tools and the thread's history in
 * memory, so the window is a trade-off between how long a conversation stays
 * warm and how much memory the server holds.
 */
const residentIdleTimeoutMs = (): number => {
  const configured = Number(process.env.CLOUDCLI_CODEX_RESIDENT_IDLE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : RESIDENT_IDLE_TIMEOUT_MS;
};

/**
 * How many conversations may hold a resident process at the same time.
 *
 * One app-server process group costs about 158 MB of resident memory, so the
 * ceiling is what bounds the memory the engine can hold.
 */
const residentMaxSessions = (): number => {
  const configured = Number(process.env.CLOUDCLI_CODEX_RESIDENT_MAX);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : RESIDENT_MAX_SESSIONS;
};

/**
 * The round the host submitted and the engine has not finished yet.
 *
 * Only one foreground round runs per app session at a time, so a session
 * tracks a single round. `armed` records that the engine consumed the queued
 * input, which is what makes the next `turn/started` this round's turn.
 */
type ResidentRound = {
  /** Host-generated id; the engine echoes it in its queue listing. */
  clientUserMessageId: string;
  /** The engine's queue item id, empty until the submission lands. */
  queuedItemId: string | null;
  /** Set once the engine consumed the queued input. */
  armed: boolean;
  /** The engine turn this round owns, once the engine started it. */
  turnId: string | null;
  /** Events of this round's own turn. */
  onEvent: (method: string, params: AnyRecord) => void;
  /** Server-to-client requests this round has to answer, such as approvals. */
  onRequest: (method: string, params: AnyRecord) => unknown | Promise<unknown>;
};

/**
 * One resident process and everything the host knows about it.
 *
 * `generation` increases whenever the process is replaced, so a late callback
 * from a previous process cannot clean up the current one.
 */
type ResidentSession = {
  appSessionId: string;
  generation: number;
  connection: CodexAppServerConnection;
  /** The native thread the rounds run in. */
  threadId: string;
  /** The round in flight, if any. */
  round: ResidentRound | null;
  /** Turns the engine started on its own, so their events stay out of the round. */
  engineTurns: Set<string>;
  /**
   * Events of a turn whose owner is not decided yet.
   *
   * The engine reports the consumption of a queued input before it announces
   * the turn that input produced, and the host learns about the consumption
   * through a list call. A turn that arrives in between is therefore held
   * here until the queue says which side owns it.
   */
  pendingTurn: { turnId: string | null; events: Array<{ method: string; params: AnyRecord }> } | null;
  /** The shared initialization, so concurrent borrows open one process. */
  initializing: Promise<ResidentSession> | null;
  /** When the session was last used, for the capacity eviction order. */
  lastUsedAt: number;
  /** The reclaim timer of an idle session. */
  idleTimer: NodeJS.Timeout | null;
  /** Set once the session is torn down, so late callbacks stop touching it. */
  disposed: boolean;
  /** Whether the session still has work that must not be reclaimed. */
  isBusy: () => boolean;
  /** Events of turns the engine started on its own. */
  onEngineEvent: (method: string, params: AnyRecord, threadId: string) => void;
  /** Called when the process of the session dies. */
  onSessionExit: (reason: string) => void;
};

/** The resident session a caller borrows. */
export type CodexResidentSession = {
  appSessionId: string;
  /** Increases whenever the process is replaced. */
  generation: number;
  /** The native thread the rounds run in. */
  threadId: string;
  connection: CodexAppServerConnection;
};

/** What a caller needs to open or reuse a resident session. */
export type CodexResidentSessionOptions = {
  /** The app session the process belongs to. */
  appSessionId: string;
  /** The native thread to continue, or null to start a new one. */
  nativeThreadId: string | null;
  /** The working directory the rounds run in. */
  workingDirectory: string;
  /**
   * The environment the child process starts with.
   *
   * It is built from the process generation, because the narrow credential a
   * resident process carries is bound to it.
   */
  env?: (generation: number) => NodeJS.ProcessEnv | undefined;
  /**
   * The thread configuration the engine applies.
   *
   * It is built from the open connection, because reading the effective
   * configuration of the machine needs one.
   */
  config?: (connection: CodexAppServerConnection) => Promise<Record<string, unknown>>;
  /** The approval policy the rounds use. */
  approvalPolicy: string;
  /** The sandbox mode the rounds use. */
  sandboxMode: string;
  /**
   * Events of turns the engine started on its own.
   *
   * The handler belongs to the session, not to a round: a resident process
   * reports after the round that started it is gone, so the handler must not
   * depend on a round's writer.
   */
  onEngineEvent?: (method: string, params: AnyRecord, threadId: string) => void;
  /** Called when the process of the session dies. */
  onSessionExit?: (reason: string) => void;
  /** Whether the session still has work that must not be reclaimed. */
  isBusy?: () => boolean;
};

/** What a caller needs to submit a round. */
export type CodexResidentRoundOptions = {
  appSessionId: string;
  /** The user input, in the shape app-server's queue accepts. */
  input: AnyRecord[];
  /** The model the round runs with. */
  model?: string;
  /** The reasoning effort the round runs with. */
  effort?: string;
  /** The working directory the round runs in. */
  workingDirectory?: string;
  /** The approval policy the round runs with. */
  approvalPolicy?: string;
  /** The sandbox mode the round runs with. */
  sandboxMode?: string;
  /** Events of this round's own turn. */
  onEvent: (method: string, params: AnyRecord) => void;
  /** Server-to-client requests this round has to answer, such as approvals. */
  onRequest: (method: string, params: AnyRecord) => unknown | Promise<unknown>;
};

const residentSessions = new Map<string, ResidentSession>();

/** Reads the turn id an event carries, whichever field it arrives in. */
function readEventTurnId(params: AnyRecord): string | null {
  const turn = params.turn && typeof params.turn === 'object' ? params.turn as AnyRecord : null;
  const candidates = [turn?.id, params.turnId, params.turn_id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

/** Reads the thread id an event carries, whichever field it arrives in. */
function readEventThreadId(params: AnyRecord): string | null {
  const candidates = [params.threadId, params.thread_id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Closes a session and forgets it.
 *
 * The generation check keeps a late callback of a replaced process from
 * closing the process that replaced it.
 */
function disposeResidentSession(session: ResidentSession, reason: string): void {
  if (session.disposed) {
    return;
  }
  session.disposed = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (residentSessions.get(session.appSessionId) === session) {
    residentSessions.delete(session.appSessionId);
  }
  try {
    session.connection.close();
  } catch (error) {
    console.warn(`[Codex] Closing the resident session ${session.appSessionId} failed:`, error);
  }
  console.log(`[Codex] Resident session ${session.appSessionId} closed (${reason}).`);
}

/**
 * Arms the round whose queued input the engine just consumed.
 *
 * The engine reports the consumption as `thread/queue/changed`, and it does so
 * after the item is gone, so listing the queue is enough to tell whether the
 * round is armed.
 */
async function refreshRoundArmedState(session: ResidentSession): Promise<void> {
  const round = session.round;
  if (!round || round.armed || round.turnId) {
    return;
  }
  const listed = await session.connection.call('thread/queue/list', { threadId: session.threadId })
    .catch((error: unknown) => {
      console.warn(`[Codex] Reading the queue of ${session.appSessionId} failed:`, error);
      return null;
    });
  if (!listed || session.disposed || session.round !== round) {
    return;
  }
  const items = Array.isArray((listed as AnyRecord)?.data) ? (listed as AnyRecord).data as AnyRecord[] : [];
  const stillQueued = items.some((item) => item?.clientUserMessageId === round.clientUserMessageId);
  if (!stillQueued) {
    round.armed = true;
  }
}

/**
 * Routes one notification to the round it belongs to.
 *
 * A turn the engine started on its own is reported as engine work, never as
 * the round's, so a background report cannot end the user's round.
 */
function routeResidentNotification(session: ResidentSession, method: string, params: AnyRecord): void {
  const turnId = readEventTurnId(params);
  const round = session.round;

  if (method === 'turn/started') {
    if (round && !round.turnId) {
      if (round.armed) {
        round.turnId = turnId;
        round.onEvent(method, params);
        return;
      }
      // The engine may have consumed the queued input right before this turn
      // started, but the host has not seen the consumption yet. The turn is
      // held until the queue says who owns it.
      session.pendingTurn = { turnId, events: [{ method, params }] };
      void resolvePendingTurn(session);
      return;
    }
    if (turnId) {
      session.engineTurns.add(turnId);
    }
    session.onEngineEvent(method, params, session.threadId);
    return;
  }

  if (session.pendingTurn) {
    session.pendingTurn.events.push({ method, params });
    return;
  }

  if (turnId && round?.turnId === turnId) {
    round.onEvent(method, params);
    return;
  }
  if (turnId && session.engineTurns.has(turnId)) {
    session.onEngineEvent(method, params, session.threadId);
    return;
  }
  if (turnId) {
    // An event of a turn this session never saw start. It belongs to neither
    // the round nor a known engine turn, so it must not end the round.
    session.onEngineEvent(method, params, session.threadId);
    return;
  }
  if (round) {
    round.onEvent(method, params);
    return;
  }
  session.onEngineEvent(method, params, session.threadId);
}

/**
 * Decides who owns the turn that was held back, and hands its events over.
 *
 * The queue decides: a consumed queued input means the turn belongs to the
 * round, a queued input that is still waiting means the engine started the
 * turn on its own.
 */
async function resolvePendingTurn(session: ResidentSession): Promise<void> {
  await refreshRoundArmedState(session);
  const pending = session.pendingTurn;
  if (!pending) {
    return;
  }
  const round = session.round;
  if (round && round.armed && !round.turnId) {
    round.turnId = pending.turnId;
    session.pendingTurn = null;
    for (const event of pending.events) {
      round.onEvent(event.method, event.params);
    }
    return;
  }
  session.pendingTurn = null;
  if (pending.turnId) {
    session.engineTurns.add(pending.turnId);
  }
  for (const event of pending.events) {
    session.onEngineEvent(event.method, event.params, session.threadId);
  }
}

/** Builds the handlers a resident connection reports through. */
function buildResidentHandlers(session: ResidentSession): CodexAppServerHandlers {
  return {
    onNotification: (method, params) => {
      if (session.disposed) {
        return;
      }
      const eventThreadId = readEventThreadId(params);
      if (eventThreadId && eventThreadId !== session.threadId) {
        // Subagents and auxiliary threads report on the same connection.
        session.onEngineEvent(method, params, session.threadId);
        return;
      }
      if (method === 'thread/queue/changed') {
        // The manager consumes this one: it says the engine took a queued
        // input, which is what arms the round that submitted it.
        void refreshRoundArmedState(session);
        return;
      }
      routeResidentNotification(session, method, params);
    },
    onRequest: async (method, params) => {
      const round = session.round;
      if (!round) {
        return undefined;
      }
      return round.onRequest(method, params);
    },
    onExit: (reason) => {
      disposeResidentSession(session, `process exited: ${reason}`);
      session.onSessionExit(reason);
    },
  };
}

/**
 * Starts the reclaim timer of a session that has no work.
 *
 * Only a session without a round, without engine work and without other
 * borrow may be reclaimed; a new round clears the timer again.
 */
function scheduleResidentReclaim(session: ResidentSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (session.disposed || session.round) {
    return;
  }
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (session.disposed || session.round || session.isBusy()) {
      return;
    }
    disposeResidentSession(session, 'idle');
  }, residentIdleTimeoutMs());
  session.idleTimer.unref?.();
}

/**
 * Frees a slot when the resident processes are at their limit.
 *
 * The least recently used session that holds no work goes first; when every
 * session holds work, the caller is told instead of an active session being
 * killed to make room.
 */
function evictResidentSessionIfNeeded(): void {
  const limit = residentMaxSessions();
  if (residentSessions.size < limit) {
    return;
  }
  const candidates = [...residentSessions.values()]
    .filter((session) => !session.round && !session.isBusy())
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  const evicted = candidates[0];
  if (evicted) {
    disposeResidentSession(evicted, 'evicted for capacity');
    return;
  }
  throw new Error(
    `Codex is already keeping ${limit} conversations alive. `
    + 'Wait for one of them to finish, or close the conversations you do not need.',
  );
}

/**
 * Borrows the resident session of an app session, opening it when needed.
 *
 * Concurrent borrows share one initialization, so two rounds of the same app
 * session never open two processes.
 */
export async function acquireCodexResidentSession(
  options: CodexResidentSessionOptions,
): Promise<CodexResidentSession> {
  const existing = residentSessions.get(options.appSessionId);
  if (existing && !existing.disposed) {
    existing.lastUsedAt = Date.now();
    // The latest borrower's callbacks describe the current state of the
    // conversation, so they replace the ones of the previous borrower.
    existing.onEngineEvent = options.onEngineEvent ?? existing.onEngineEvent;
    existing.onSessionExit = options.onSessionExit ?? existing.onSessionExit;
    existing.isBusy = options.isBusy ?? existing.isBusy;
    if (existing.initializing) {
      await existing.initializing;
    }
    const settled = residentSessions.get(options.appSessionId);
    if (settled && !settled.disposed) {
      settled.lastUsedAt = Date.now();
      if (settled.idleTimer) {
        clearTimeout(settled.idleTimer);
        settled.idleTimer = null;
      }
      return {
        appSessionId: settled.appSessionId,
        generation: settled.generation,
        threadId: settled.threadId,
        connection: settled.connection,
      };
    }
  }

  evictResidentSessionIfNeeded();

  const session: ResidentSession = {
    appSessionId: options.appSessionId,
    generation: (existing?.generation ?? 0) + 1,
    connection: undefined as unknown as CodexAppServerConnection,
    threadId: '',
    round: null,
    engineTurns: new Set<string>(),
    pendingTurn: null,
    initializing: null,
    lastUsedAt: Date.now(),
    idleTimer: null,
    disposed: false,
    isBusy: options.isBusy ?? (() => false),
    onEngineEvent: options.onEngineEvent ?? (() => {}),
    onSessionExit: options.onSessionExit ?? (() => {}),
  };

  const initialization = (async () => {
    const processEnv = options.env?.(session.generation);
    const connection = await codexAppServerTransport.open(
      buildResidentHandlers(session),
      { experimentalApi: true, ...(processEnv ? { env: processEnv } : {}) },
    );
    session.connection = connection;
    const threadConfig = options.config ? await options.config(connection) : {};
    const thread = await connection.call(
      options.nativeThreadId ? 'thread/resume' : 'thread/start',
      {
        ...(options.nativeThreadId ? { threadId: options.nativeThreadId } : {}),
        cwd: options.workingDirectory,
        approvalPolicy: options.approvalPolicy,
        sandboxPolicy: { mode: options.sandboxMode },
        config: threadConfig,
      },
    ) as { thread?: { id?: unknown } } | undefined;
    const threadId = typeof thread?.thread?.id === 'string' ? thread.thread.id : '';
    if (!threadId) {
      connection.close();
      throw new Error('Codex app-server opened no thread to run the session in.');
    }
    session.threadId = threadId;
    session.initializing = null;
    residentSessions.set(options.appSessionId, session);
    return session;
  })();

  session.initializing = initialization;
  residentSessions.set(options.appSessionId, session);

  try {
    const settled = await initialization;
    settled.lastUsedAt = Date.now();
    // The session is idle until its round is submitted, so the reclaim window
    // starts here rather than at the end of the round.
    scheduleResidentReclaim(settled);
    return {
      appSessionId: settled.appSessionId,
      generation: settled.generation,
      threadId: settled.threadId,
      connection: settled.connection,
    };
  } catch (error) {
    if (residentSessions.get(options.appSessionId) === session) {
      residentSessions.delete(options.appSessionId);
    }
    throw error;
  }
}

/**
 * Submits a round to the engine's queue.
 *
 * The engine starts the round when the thread is idle and keeps it queued
 * while the thread is busy, which is what keeps a background report from
 * swallowing the input.
 */
export async function submitCodexResidentRound(
  options: CodexResidentRoundOptions,
): Promise<{ clientUserMessageId: string }> {
  const session = residentSessions.get(options.appSessionId);
  if (!session || session.disposed) {
    throw new Error('The Codex conversation is no longer resident. Send the message again.');
  }
  if (session.round) {
    throw new Error('The Codex conversation is already answering.');
  }
  if (session.initializing) {
    await session.initializing;
  }

  const clientUserMessageId = randomUUID();
  const round: ResidentRound = {
    clientUserMessageId,
    queuedItemId: null,
    armed: false,
    turnId: null,
    onEvent: options.onEvent,
    onRequest: options.onRequest,
  };
  session.round = round;
  session.lastUsedAt = Date.now();

  try {
    if (options.model || options.effort || options.workingDirectory || options.approvalPolicy || options.sandboxMode) {
      await session.connection.call('thread/settings/update', {
        threadId: session.threadId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.sandboxMode ? { sandboxPolicy: { mode: options.sandboxMode } } : {}),
      });
    }

    const added = await session.connection.call('thread/queue/add', {
      threadId: session.threadId,
      input: options.input,
      clientUserMessageId,
    }) as { queuedSubmission?: { id?: unknown } } | undefined;
    const queuedItemId = typeof added?.queuedSubmission?.id === 'string' ? added.queuedSubmission.id : null;
    round.queuedItemId = queuedItemId;
    // The engine may have consumed the item while the request was in flight.
    await refreshRoundArmedState(session);
    return { clientUserMessageId };
  } catch (error) {
    session.round = null;
    scheduleResidentReclaim(session);
    throw error;
  }
}

/**
 * Stops the round of a session.
 *
 * A round that already started is interrupted; a round that is still queued is
 * removed from the queue, which is the only way to cancel it.
 */
export async function stopCodexResidentRound(
  appSessionId: string,
): Promise<'interrupted' | 'cancelled' | 'not-found'> {
  const session = residentSessions.get(appSessionId);
  if (!session || session.disposed) {
    return 'not-found';
  }
  const round = session.round;
  if (!round) {
    return 'not-found';
  }
  if (round.turnId) {
    await session.connection.call('turn/interrupt', {
      threadId: session.threadId,
      turnId: round.turnId,
    }).catch((error: unknown) => {
      console.warn(`[Codex] Interrupt for ${appSessionId} was not accepted:`, error);
    });
    return 'interrupted';
  }
  if (round.queuedItemId) {
    await session.connection.call('thread/queue/delete', {
      threadId: session.threadId,
      queuedSubmissionId: round.queuedItemId,
    }).catch((error: unknown) => {
      console.warn(`[Codex] Removing the queued message of ${appSessionId} failed:`, error);
    });
  }
  session.round = null;
  scheduleResidentReclaim(session);
  return 'cancelled';
}

/**
 * Ends a round after the engine reported its terminal state.
 *
 * The process stays alive: the next round continues in the same thread.
 */
export function completeCodexResidentRound(appSessionId: string): void {
  const session = residentSessions.get(appSessionId);
  if (!session) {
    return;
  }
  session.round = null;
  session.pendingTurn = null;
  session.engineTurns.clear();
  session.lastUsedAt = Date.now();
  scheduleResidentReclaim(session);
}

/**
 * Releases a session that is not used any more.
 *
 * `dispose` ends the process right away, which is what a deleted or archived
 * conversation needs.
 */
export function releaseCodexResidentSession(appSessionId: string, options?: { dispose?: boolean }): void {
  const session = residentSessions.get(appSessionId);
  if (!session) {
    return;
  }
  if (options?.dispose) {
    disposeResidentSession(session, 'released');
    return;
  }
  session.lastUsedAt = Date.now();
  scheduleResidentReclaim(session);
}

/** The resident sessions that are currently open, for diagnostics and tests. */
export function listCodexResidentSessions(): Array<{ appSessionId: string; generation: number; threadId: string }> {
  return [...residentSessions.values()]
    .filter((session) => !session.disposed)
    .map((session) => ({
      appSessionId: session.appSessionId,
      generation: session.generation,
      threadId: session.threadId,
    }));
}

/**
 * Closes every resident session.
 *
 * Used by the server shutdown, where the process must not outlive the host.
 */
export function closeCodexResidentSessions(): void {
  for (const session of [...residentSessions.values()]) {
    disposeResidentSession(session, 'host shutdown');
  }
}

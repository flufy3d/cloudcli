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

/** How often the queue is read again when the read failed. */
const QUEUE_READ_ATTEMPTS = 3;

/** How long the host waits before it reads the queue again. */
const QUEUE_READ_RETRY_MS = 50;

/** Waits a moment, for the retry of a queue read that failed. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

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
  /** The trusted user the conversation belongs to. */
  userId: string | null;
  generation: number;
  connection: CodexAppServerConnection;
  /** The native thread the rounds run in. */
  threadId: string;
  /** The round in flight, if any. */
  round: ResidentRound | null;
  /** Turns the engine started on its own, so their events stay out of the round. */
  engineTurns: Set<string>;
  /**
   * The turns whose owner is not decided yet, keyed by turn id.
   *
   * The engine reports the consumption of a queued input before it announces
   * the turn that input produced, and the host learns about the consumption
   * through a list call. A turn that arrives in between is therefore held
   * here until the queue says which side owns it. More than one turn can be
   * waiting: the engine may start a report of its own while the user's input
   * is still queued.
   */
  pendingTurns: Map<string, {
    turnId: string | null;
    events: Array<{ method: string; params: AnyRecord }>;
  }>;
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
  /** Answers a request the engine makes when no round is in flight. */
  onSessionRequest: (method: string, params: AnyRecord) => unknown | Promise<unknown>;
  /** Called when the round ends without the engine reporting a terminal state. */
  onRoundEnded: (reason: 'cancelled' | 'unknown') => void;
  /** The credential the process carried, revoked when the process is gone. */
  credentialToken: string | null;
  /** Revokes the credential the process carried. */
  revokeCredential: (token: string) => void;
  /** Called when the process of the session is closed. */
  onSessionDisposed: () => void;
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
  /**
   * The trusted user the conversation belongs to.
   *
   * A process is never handed to another user, even for the same app
   * session id.
   */
  userId?: string | null;
  /** The native thread to continue, or null to start a new one. */
  nativeThreadId: string | null;
  /** The working directory the rounds run in. */
  workingDirectory: string;
  /**
   * The environment the child process starts with, and the credential that
   * environment carries.
   *
   * It is built from the process generation, because the narrow credential a
   * resident process carries is bound to it. The credential is handed to the
   * manager, so the manager can revoke it when the process is gone — a later
   * borrow of the same process must not replace the callback that does that.
   */
  env?: (generation: number) => {
    env: NodeJS.ProcessEnv;
    credentialToken?: string;
  } | null | undefined;
  /**
   * The thread configuration the engine applies.
   *
   * It is built from the open connection, because reading the effective
   * configuration of the machine needs one.
   */
  config?: (connection: CodexAppServerConnection) => Promise<Record<string, unknown>>;
  /** The approval policy the rounds use. */
  approvalPolicy: string;
  /**
   * The sandbox mode the thread runs in.
   *
   * The protocol names the mode of a thread differently from the policy of a
   * turn: a thread takes `workspace-write` / `danger-full-access`, a turn
   * takes the policy object below. Sending one shape where the other
   * belongs is silently ignored by the engine, so both travel.
   */
  sandbox: 'workspace-write' | 'danger-full-access';
  /** The sandbox policy the rounds use. */
  sandboxPolicy: { type: 'workspaceWrite' | 'dangerFullAccess'; networkAccess: boolean };
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
  /**
   * Answers a request the engine makes when no round is in flight.
   *
   * A resident process can be asked for an approval while the user is not
   * waiting for a turn, and the engine blocks on the answer.
   */
  onSessionRequest?: (method: string, params: AnyRecord) => unknown | Promise<unknown>;
  /**
   * Called when the round ends without the engine reporting a terminal state.
   *
   * `cancelled` means the queued input was withdrawn; `unknown` means the
   * round's turn could not be identified. Either way the round must not wait
   * for an event that will never come.
   */
  onRoundEnded?: (reason: 'cancelled' | 'unknown') => void;
  /** Revokes the credential the process carried, when the process is gone. */
  revokeCredential?: (token: string) => void;
  /** Called when the process of the session is closed. */
  onSessionDisposed?: () => void;
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
  /** The sandbox mode the round runs in. */
  sandbox?: 'workspace-write' | 'danger-full-access';
  /** The sandbox policy the round runs with. */
  sandboxPolicy?: { type: 'workspaceWrite' | 'dangerFullAccess'; networkAccess: boolean };
  /** Events of this round's own turn. */
  onEvent: (method: string, params: AnyRecord) => void;
  /** Server-to-client requests this round has to answer, such as approvals. */
  onRequest: (method: string, params: AnyRecord) => unknown | Promise<unknown>;
};

const residentSessions = new Map<string, ResidentSession>();

/**
 * The sessions whose admission is closed.
 *
 * Archiving or deleting a conversation has to look at its state and act on
 * it, and a run that starts in between would leave work behind. Closing the
 * admission first makes the check and the action one step.
 */
const closedAdmission = new Set<string>();

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
  // The credential the process carried only ever authorized that process.
  if (session.credentialToken) {
    try {
      session.revokeCredential(session.credentialToken);
    } catch (error) {
      console.warn(`[Codex] Revoking the credential of ${session.appSessionId} failed:`, error);
    }
    session.credentialToken = null;
  }
  try {
    session.onSessionDisposed();
  } catch (error) {
    console.warn(`[Codex] Releasing the work of ${session.appSessionId} failed:`, error);
  }
  console.log(`[Codex] Resident session ${session.appSessionId} closed (${reason}).`);
}

/**
 * The queued inputs of a thread, read over every page.
 *
 * The queue listing is paginated, and the arming of a round asks whether one
 * item is still in it: a partial page could hide the item and make a
 * consumed input look queued.
 */
async function readQueuedItems(session: ResidentSession): Promise<AnyRecord[]> {
  const items: AnyRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const listed = await session.connection.call('thread/queue/list', {
      threadId: session.threadId,
      ...(cursor ? { cursor } : {}),
    }) as AnyRecord | undefined;
    const data = Array.isArray(listed?.data) ? listed.data as AnyRecord[] : [];
    items.push(...data);
    const next = listed?.nextCursor;
    if (typeof next !== 'string' || !next) {
      return items;
    }
    cursor = next;
  }
  return items;
}

/**
 * What the queue says about the round's queued input.
 *
 * `armed` means the engine consumed it, `queued` means it is still waiting,
 * `unreadable` means the queue could not be read at all, and `gone` means the
 * round itself is over. Only `unreadable` ends the round: the round's turn
 * cannot be identified, and waiting for it would hang the run.
 */
type QueueArmingState = 'armed' | 'queued' | 'unreadable' | 'gone';

/**
 * Arms the round whose queued input the engine just consumed.
 *
 * The engine reports the consumption as `thread/queue/changed`, and it does so
 * after the item is gone, so listing the queue is enough to tell whether the
 * round is armed.
 */
async function refreshRoundArmedState(session: ResidentSession): Promise<QueueArmingState> {
  const round = session.round;
  if (!round) {
    return 'gone';
  }
  if (round.armed) {
    return 'armed';
  }
  if (round.turnId) {
    return 'queued';
  }
  for (let attempt = 0; attempt < QUEUE_READ_ATTEMPTS; attempt += 1) {
    try {
      const items = await readQueuedItems(session);
      if (session.disposed || session.round !== round) {
        return 'gone';
      }
      if (!items.some((item) => item?.clientUserMessageId === round.clientUserMessageId)) {
        round.armed = true;
        return 'armed';
      }
      return 'queued';
    } catch (error) {
      if (attempt === QUEUE_READ_ATTEMPTS - 1) {
        console.warn(`[Codex] Reading the queue of ${session.appSessionId} failed:`, error);
        return 'unreadable';
      }
      await sleep(QUEUE_READ_RETRY_MS);
    }
  }
  return 'unreadable';
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
      const key = turnId ?? `turn-without-id-${randomUUID()}`;
      session.pendingTurns.set(key, { turnId, events: [{ method, params }] });
      void resolvePendingTurn(session, key);
      return;
    }
    if (turnId) {
      session.engineTurns.add(turnId);
    }
    session.onEngineEvent(method, params, session.threadId);
    return;
  }

  // The event of a turn whose owner is not decided yet waits with it.
  if (turnId && session.pendingTurns.has(turnId)) {
    session.pendingTurns.get(turnId)?.events.push({ method, params });
    return;
  }

  if (method === 'turn/completed' && turnId) {
    // The engine's own turn is over; it must not keep the session busy.
    session.engineTurns.delete(turnId);
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
 * turn on its own. A queue that cannot be read leaves the round's turn
 * unidentified, and the round ends as unknown rather than waiting for an
 * event that may never be identified.
 */
async function resolvePendingTurn(session: ResidentSession, key: string): Promise<void> {
  const armed = await refreshRoundArmedState(session);
  const pending = session.pendingTurns.get(key);
  if (!pending) {
    return;
  }
  session.pendingTurns.delete(key);
  const round = session.round;
  if (armed === 'unreadable') {
    console.warn(
      `[Codex] The turn of ${session.appSessionId} could not be identified; the round ends as unknown.`,
    );
    session.onRoundEnded('unknown');
  }
  // The engine starts the turns of a thread in order, so the last waiting
  // turn is the one the round's own input produced; an earlier one is the
  // engine reporting on its own.
  const isLatestWaitingTurn = session.pendingTurns.size === 0;
  if (armed === 'armed' && round && !round.turnId && isLatestWaitingTurn) {
    round.turnId = pending.turnId;
    for (const event of pending.events) {
      round.onEvent(event.method, event.params);
    }
    return;
  }
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
        // The engine blocks on the answer, so a request without a round still
        // gets one: it belongs to the session, not to a round.
        return session.onSessionRequest(method, params);
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
    existing.onSessionRequest = options.onSessionRequest ?? existing.onSessionRequest;
    existing.onRoundEnded = options.onRoundEnded ?? existing.onRoundEnded;
    existing.onSessionDisposed = options.onSessionDisposed ?? existing.onSessionDisposed;
    existing.isBusy = options.isBusy ?? existing.isBusy;
    const wasInitializing = Boolean(existing.initializing);
    if (existing.initializing) {
      await existing.initializing;
    }
    const settled = residentSessions.get(options.appSessionId);
    if (settled && !settled.disposed) {
      // An edited message forks a new native thread, and the old process
      // cannot serve it: the next round would go to the thread the edit
      // replaced, and the edit would silently disappear.
      const threadChanged = Boolean(options.nativeThreadId)
        && settled.threadId !== options.nativeThreadId;
      const userChanged = Boolean(options.userId) && settled.userId !== options.userId;
      if (!threadChanged && !userChanged) {
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
      console.log(
        `[Codex] The conversation of ${options.appSessionId} moved to another thread or user; the resident process is replaced.`,
      );
      disposeResidentSession(settled, 'the thread or the user changed');
    }
  }

  evictResidentSessionIfNeeded();

  const session: ResidentSession = {
    appSessionId: options.appSessionId,
    userId: options.userId ?? null,
    generation: (existing?.generation ?? 0) + 1,
    connection: undefined as unknown as CodexAppServerConnection,
    threadId: '',
    round: null,
    engineTurns: new Set<string>(),
    pendingTurns: new Map(),
    initializing: null,
    lastUsedAt: Date.now(),
    idleTimer: null,
    disposed: false,
    isBusy: options.isBusy ?? (() => false),
    onEngineEvent: options.onEngineEvent ?? (() => {}),
    onSessionExit: options.onSessionExit ?? (() => {}),
    onSessionRequest: options.onSessionRequest ?? (() => undefined),
    onRoundEnded: options.onRoundEnded ?? (() => {}),
    credentialToken: null,
    revokeCredential: options.revokeCredential ?? (() => {}),
    onSessionDisposed: options.onSessionDisposed ?? (() => {}),
  };

  const initialization = (async () => {
    const processSetup = options.env?.(session.generation);
    if (processSetup?.credentialToken) {
      session.credentialToken = processSetup.credentialToken;
    }
    const connection = await codexAppServerTransport.open(
      buildResidentHandlers(session),
      { experimentalApi: true, ...(processSetup ? { env: processSetup.env } : {}) },
    );
    session.connection = connection;
    const threadConfig = options.config ? await options.config(connection) : {};
    const thread = await connection.call(
      options.nativeThreadId ? 'thread/resume' : 'thread/start',
      {
        ...(options.nativeThreadId ? { threadId: options.nativeThreadId, excludeTurns: true } : {}),
        cwd: options.workingDirectory,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
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
  if (closedAdmission.has(options.appSessionId)) {
    throw new Error('The Codex conversation is being closed and cannot take another message.');
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
    if (options.model || options.effort || options.workingDirectory || options.approvalPolicy || options.sandboxPolicy) {
      await session.connection.call('thread/settings/update', {
        threadId: session.threadId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.sandboxPolicy ? { sandboxPolicy: options.sandboxPolicy } : {}),
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
  session.pendingTurns.clear();
  // The engine will report no turn for an input that was withdrawn, so the
  // round ends here instead of waiting for a terminal event that never comes.
  session.onRoundEnded('cancelled');
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
  session.pendingTurns.clear();
  // The engine's own turns are not cleared here: a report the engine started
  // is still running, and the session must not look idle while it does.
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

/**
 * Whether the session still has work that must not be reclaimed.
 *
 * A round in flight, a report the engine started on its own, or an agent
 * that is still running all count: the session cannot be archived away while
 * they are alive.
 */
export function isCodexResidentSessionBusy(appSessionId: string): boolean {
  const session = residentSessions.get(appSessionId);
  if (!session || session.disposed) {
    return false;
  }
  return Boolean(session.round) || session.engineTurns.size > 0 || session.isBusy();
}

/**
 * Whether the session's admission is closed.
 *
 * A conversation that is being archived or deleted must not start a round
 * while the action is in flight, whichever path the round takes.
 */
export function isCodexResidentSessionAdmissionClosed(appSessionId: string): boolean {
  return closedAdmission.has(appSessionId);
}

/**
 * Stops new rounds from starting in the session.
 *
 * The caller checks the session's state afterwards and releases it, so a
 * run cannot slip in between the check and the action.
 */
export function closeCodexResidentSessionAdmission(appSessionId: string): void {
  closedAdmission.add(appSessionId);
}

/**
 * Releases the resources the session holds.
 *
 * The process is closed. The admission stays closed, because the caller is in
 * the middle of an action on the session and a new round must not start
 * before that action is done.
 */
export function releaseCodexResidentSessionResources(appSessionId: string): void {
  releaseCodexResidentSession(appSessionId, { dispose: true });
}

/**
 * Opens the session's admission again.
 *
 * Called once the action that closed it is done, so a conversation that was
 * only looked at stays usable.
 */
export function openCodexResidentSessionAdmission(appSessionId: string): void {
  closedAdmission.delete(appSessionId);
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

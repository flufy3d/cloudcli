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
 * resident session per app session and submits its rounds through it;
 * `codex-thread-title.ts` borrows an ephemeral thread of that session to
 * name the conversation without entering it.
 */

import { randomUUID } from 'node:crypto';

import {
  codexAppServerTransport,
  type CodexAppServerConnection,
  type CodexAppServerHandlers,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { AnyRecord, CodexSessionTitleTarget } from '@/shared/index.js';
import { AppError, buildCodexTitleIsolationConfig, CODEX_HOST_CREDENTIAL_ENV_NAMES } from '@/shared/index.js';

/** How long a resident process may sit idle before it is reclaimed. */
const RESIDENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** How many app sessions may hold a resident process at the same time. */
const RESIDENT_MAX_SESSIONS = 4;

/** How often the queue is read again when the read failed. */
const QUEUE_READ_ATTEMPTS = 3;

/** Maximum time to confirm an interrupt or submission-window stop. */
const STOP_CONFIRMATION_MS = 3_000;

/** Maximum time to wait for a replaced process to release the thread. */
const PROCESS_EXIT_WAIT_MS = 5_000;
type ResidentStopResult = 'interrupted' | 'cancelled' | 'not-found' | 'unknown';

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
  /** A stop waits until submission can be identified or has failed. */
  submitted: Promise<void>;
  /** Tool results are submitted by turn/start and bound to its returned turn id. */
  directSubmission: boolean;
  /** Repeated stop requests share one operation and one deadline. */
  stopping: Promise<ResidentStopResult> | null;
  stopTimer: NodeJS.Timeout | null;
  terminalSeen: boolean;
  /** Set once the engine consumed the queued input. */
  armed: boolean;
  /** The engine turn this round owns, once the engine started it. */
  turnId: string | null;
  /** Events of this round's own turn. */
  onEvent: (method: string, params: AnyRecord) => void;
  /** Server-to-client requests this round has to answer, such as approvals. */
  onRequest: (method: string, params: AnyRecord) => unknown | Promise<unknown>;
};

/** What the manager keeps about one lent ephemeral thread: where its traffic goes. */
type AuxiliaryBorrow = {
  failed: boolean;
  onNotification: (method: string, params: AnyRecord) => void;
  onRequest?: (method: string, params: AnyRecord) => unknown | Promise<unknown>;
  onDisposed?: (reason: string) => void;
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
  /** A one-shot process is never reused or reclaimed before its owning turn releases it. */
  lifetime: 'session' | 'turn';
  /** The runtime owns the preparation window before its round is registered. */
  reservedForRound: boolean;
  connection: CodexAppServerConnection;
  /** The native thread the rounds run in. */
  threadId: string;
  /** Explicit native name; never the first-message preview. */
  nativeName: string | null;
  auxiliaryOwner: string | null;
  auxiliaryTargetThreadId: string | null;
  /** The round in flight, if any. */
  round: ResidentRound | null;
  /** Turns the engine started on its own, so their events stay out of the round. */
  engineTurns: Set<string>;
  /** Unanswered engine requests keep their owning process alive. */
  pendingRequests: number;
  /**
   * The ephemeral threads lent to auxiliary borrowers, keyed by thread id.
   *
   * A lent thread's events and requests go to its borrower only; while any is
   * lent the process has work and is not reclaimed.
   */
  auxThreads: Map<string, AuxiliaryBorrow>;
  /** Retired ids also reject late events/approvals until this process exits. */
  auxiliaryThreadIds: Set<string>;
  /** Starts in flight also prevent reclaim, eviction and archive. */
  auxiliaryStarting: number;
  /** Source markers used by auxiliary starts on this process, including timed-out starts. */
  auxiliarySources: Set<string>;
  /** Unclaimed startup announcements, retained until registration or bounded detach. */
  auxiliaryAnnouncements: Map<string, 'waiting' | 'detaching'>;
  /** Notification order is independent of asynchronous queue-read completion order. */
  latestPendingTurnKey: string | null;
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
    resolution: Promise<void> | null;
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
  onRoundEnded: (reason: 'cancelled' | 'unknown', cause?: 'stop' | 'interrupt') => void;
  /** The credential the process carried, revoked when the process is gone. */
  credentialToken: string | null;
  /** Revokes the credential the process carried. */
  revokeCredential: (token: string) => void;
  /** Called when the process of the session is closed. */
  onSessionDisposed: () => void;
};

/** The resident session a caller borrows. */
export type CodexResidentSession = {
  /** Current explicit name, refreshed by engine metadata reads and name notifications. */
  readonly nativeName: string | null;
  appSessionId: string;
  /** Increases whenever the process is replaced. */
  generation: number;
  /** The native thread the rounds run in. */
  threadId: string;
  connection: CodexAppServerConnection;
};

/** What a caller needs to open or reuse a resident session. */
export type CodexResidentSessionOptions = {
  /** Manager-internal transient worker, never a resumed formal conversation. */
  auxiliaryWorker?: { ownerAppSessionId: string; nativeThreadId: string; deadline: number };
  /** Tool-result callers request an exclusive fresh process that lives for one turn. */
  lifetime?: 'session' | 'turn';
  /** Chat runtime reserves input preparation; diagnostics may share an unreserved connection. */
  reserveForRound?: boolean;
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
  onRoundEnded?: (reason: 'cancelled' | 'unknown', cause?: 'stop' | 'interrupt') => void;
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
  /** Chat runtime binds submission to the connection it acquired. */
  generation?: number;
  /** The user input, in the shape app-server's queue accepts. */
  input: AnyRecord[];
  /** Native tool result input; the engine queue only accepts user input. */
  toolOutput?: AnyRecord;
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
 * The exit of a process that was released, per app session.
 *
 * A thread can only be resumed by one process at a time, so the process that
 * held it has to be gone before the next one takes it over. The exit is
 * remembered here because the release itself is synchronous.
 */
const releasedProcessExits = new Map<string, Promise<void>>();
// Monotonic across removal/recreation; old credentials never name a new process.
let nextProcessGeneration = 0;

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

/**
 * Reads the thread id an event carries, whichever field it arrives in.
 *
 * `thread/started` names its thread only inside the thread object, so that
 * announcement of another thread must not be mistaken for the session's own.
 */
function readEventThreadId(params: AnyRecord): string | null {
  const thread = params.thread && typeof params.thread === 'object' ? params.thread as AnyRecord : null;
  const candidates = [params.threadId, params.thread_id, thread?.id];
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
  if (session.round?.stopTimer) clearTimeout(session.round.stopTimer);
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (residentSessions.get(session.appSessionId) === session) {
    residentSessions.delete(session.appSessionId);
  }
  // A borrower of an ephemeral thread learns that the thread is gone with the
  // process; its handle rejects from here on.
  for (const borrow of session.auxThreads.values()) {
    try {
      if (!borrow.failed) borrow.onDisposed?.(reason);
    } catch (error) {
      console.warn(`[Codex] Telling an auxiliary borrower of ${session.appSessionId} about the closing failed:`, error);
    }
  }
  session.auxThreads.clear();
  try {
    session.connection?.close();
  } catch (error) {
    console.warn(`[Codex] Closing the resident session ${session.appSessionId} failed:`, error);
  }
  // The thread this process held is only free once it is gone.
  const exited = session.connection?.waitForExit?.() ?? null;
  if (exited) {
    releasedProcessExits.set(session.appSessionId, exited);
    void exited.then(() => {
      if (releasedProcessExits.get(session.appSessionId) === exited) releasedProcessExits.delete(session.appSessionId);
    }).catch((error) => { console.warn(`[Codex] Waiting for ${session.appSessionId} to exit failed:`, error); });
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

/** Live and buffered own-turn events acknowledge the same stop deadline. */
function deliverRoundEvent(round: ResidentRound, method: string, params: AnyRecord): void {
  if (method === 'turn/completed') {
    round.terminalSeen = true;
    if (round.stopTimer) clearTimeout(round.stopTimer);
    round.stopTimer = null;
  }
  round.onEvent(method, params);
}

/** One activity predicate shared by archive checks and both reclaim paths. */
function hasResidentWork(session: ResidentSession): boolean {
  return session.lifetime === 'turn' || session.reservedForRound || Boolean(session.initializing || session.round)
    || session.engineTurns.size > 0 || session.pendingTurns.size > 0 || session.auxThreads.size > 0 || session.auxiliaryStarting > 0 || session.auxiliaryAnnouncements.size > 0
    || session.pendingRequests > 0 || session.isBusy();
}

/** Engine turns use the same lifecycle accounting for live and buffered events. */
function deliverEngineEvent(session: ResidentSession, method: string, params: AnyRecord): void {
  const turnId = readEventTurnId(params);
  if (method === 'turn/started' && turnId) session.engineTurns.add(turnId);
  if (method === 'turn/completed' && turnId) session.engineTurns.delete(turnId);
  session.lastUsedAt = Date.now();
  session.onEngineEvent(method, params, session.threadId);
  scheduleResidentReclaim(session);
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
    if (round?.turnId && round.turnId === turnId) {
      deliverRoundEvent(round, method, params);
      return;
    }
    if (round && !round.turnId) {
      if (round.armed) {
        round.turnId = turnId;
        deliverRoundEvent(round, method, params);
        return;
      }
      // The engine may have consumed the queued input right before this turn
      // started, but the host has not seen the consumption yet. The turn is
      // held until the queue says who owns it.
      const key = turnId ?? `turn-without-id-${randomUUID()}`;
      session.latestPendingTurnKey = key;
      const pending = { turnId, events: [{ method, params }], resolution: null as Promise<void> | null };
      session.pendingTurns.set(key, pending);
      if (!round.directSubmission) {
        pending.resolution = resolvePendingTurn(session, key).catch((error: unknown) => failResidentEvent(session, error));
      }
      return;
    }
    deliverEngineEvent(session, method, params);
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
    deliverRoundEvent(round, method, params);
    return;
  }
  if (turnId && session.engineTurns.has(turnId)) {
    deliverEngineEvent(session, method, params);
    return;
  }
  if (turnId) {
    // An event of a turn this session never saw start. It belongs to neither
    // the round nor a known engine turn, so it must not end the round.
    deliverEngineEvent(session, method, params);
    return;
  }
  if (round) {
    deliverRoundEvent(round, method, params);
    return;
  }
  deliverEngineEvent(session, method, params);
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
  const isLatestWaitingTurn = session.latestPendingTurnKey === key;
  if (armed === 'armed' && round && !round.turnId && isLatestWaitingTurn) {
    round.turnId = pending.turnId;
    for (const event of pending.events) {
      deliverRoundEvent(round, event.method, event.params);
    }
    return;
  }
  for (const event of pending.events) {
    deliverEngineEvent(session, event.method, event.params);
  }
}

/** Native stream handlers must not let one malformed call crash other sessions. */
function failResidentEvent(session: ResidentSession, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[Codex] Native event handling failed for ${session.appSessionId}:`, error);
  disposeResidentSession(session, 'native event handling failed');
  session.onSessionExit(reason);
}

/** A cancelled host input must not discard the engine's concurrent report. */
function publishPendingEngineTurns(session: ResidentSession): boolean {
  const waiting = [...session.pendingTurns.values()];
  session.pendingTurns.clear();
  if (session.disposed) return false;
  try {
    for (const pending of waiting) {
      for (const event of pending.events) deliverEngineEvent(session, event.method, event.params);
    }
    return true;
  } catch (error) {
    failResidentEvent(session, error);
    return false;
  }
}

/**
 * thread/started also arrives after a transport timeout discarded the reply.
 * Once every start has settled, announcements with no returned owner are
 * detached. Waiting for all starts prevents a concurrent successful borrower
 * from losing its thread before its own response registers ownership.
 */
function detachUnclaimedAuxiliaryThreads(session: ResidentSession): void {
  if (session.disposed || session.auxiliaryStarting > 0) return;
  for (const [threadId, state] of session.auxiliaryAnnouncements) {
    if (state === 'detaching') continue;
    session.auxiliaryAnnouncements.set(threadId, 'detaching');
    scheduleResidentReclaim(session);
    void session.connection.call('thread/unsubscribe', { threadId }, { timeoutMs: 3000 })
      .catch((error) => { console.warn(`[Codex] Detaching unclaimed auxiliary thread ${threadId} failed:`, error); })
      .finally(() => {
        session.auxiliaryAnnouncements.delete(threadId);
        scheduleResidentReclaim(session);
      });
  }
}

/** Auxiliary failures stay on their thread; the caller retains cleanup access. */
function failAuxiliaryBorrow(session: ResidentSession, borrow: AuxiliaryBorrow, error: unknown): void {
  if (borrow.failed) return;
  borrow.failed = true;
  console.warn(`[Codex] Auxiliary handler failed for ${session.appSessionId}:`, error);
  try { borrow.onDisposed?.('auxiliary handler failed'); }
  catch (failure) { console.warn(`[Codex] Auxiliary failure callback failed for ${session.appSessionId}:`, failure); }
}

/** Builds the handlers a resident connection reports through. */
function buildResidentHandlers(session: ResidentSession): CodexAppServerHandlers {
  return {
    onNotification: (method, params) => {
      try {
        if (session.disposed) {
          return;
        }
        const eventThreadId = readEventThreadId(params);
        if (method === 'thread/name/updated' && eventThreadId === session.threadId) {
          session.nativeName = typeof params.threadName === 'string' && params.threadName.trim() ? params.threadName.trim() : null;
          return;
        }
        const borrow = eventThreadId ? session.auxThreads.get(eventThreadId) : undefined;
        if (borrow) {
          // A lent thread's traffic is its borrower's alone: it is neither the
          // round's nor engine work the conversation would show.
          if (!borrow.failed) {
            try { borrow.onNotification(method, params); }
            catch (error) { failAuxiliaryBorrow(session, borrow, error); }
          }
          return;
        }
        if (eventThreadId && session.auxiliaryThreadIds.has(eventThreadId)) return;
        const announced = method === 'thread/started' && params.thread && typeof params.thread === 'object'
          ? params.thread as AnyRecord : null;
        if (eventThreadId && announced?.ephemeral === true
          && typeof announced.threadSource === 'string' && session.auxiliarySources.has(announced.threadSource)) {
          session.auxiliaryThreadIds.add(eventThreadId);
          session.auxiliaryAnnouncements.set(eventThreadId, 'waiting');
          detachUnclaimedAuxiliaryThreads(session);
          return;
        }
        if (eventThreadId && session.auxiliaryAnnouncements.has(eventThreadId)) return;
        if (eventThreadId && eventThreadId !== session.threadId) {
          // Subagents report on the same connection.
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
      } catch (error) {
        failResidentEvent(session, error);
      }
    },
    onRequest: async (method, params) => {
      if (session.disposed) throw new Error('The Codex conversation is closed.');
      session.pendingRequests += 1;
      scheduleResidentReclaim(session);
      try {
        const round = session.round;
        const turnId = readEventTurnId(params);
        const threadId = readEventThreadId(params);
        const borrow = threadId ? session.auxThreads.get(threadId) : undefined;
        if (borrow) {
          // Only the borrower may answer for its thread. Without a handler the
          // request is refused, never shown to the user as the conversation's.
          if (borrow.failed) return undefined;
          try { return await borrow.onRequest?.(method, params); }
          catch (error) { failAuxiliaryBorrow(session, borrow, error); return undefined; }
        }
        if (threadId && session.auxiliaryThreadIds.has(threadId)) return undefined;
        if (round && turnId && !round.turnId) {
          await round.submitted;
          await session.pendingTurns.get(turnId)?.resolution;
        }
        if (session.disposed) throw new Error('The Codex conversation is closed.');
        const belongsToRound = round && session.round === round && turnId
          && round.turnId === turnId && (!threadId || threadId === session.threadId);
        return await (belongsToRound ? round.onRequest(method, params) : session.onSessionRequest(method, params));
      } finally {
        session.pendingRequests -= 1;
        session.lastUsedAt = Date.now();
        scheduleResidentReclaim(session);
      }
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
  if (session.disposed || hasResidentWork(session)) {
    return;
  }
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (session.disposed || hasResidentWork(session)) {
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
  if ([...residentSessions.values()].filter((session) => !session.auxiliaryOwner).length < limit) {
    return;
  }
  const candidates = [...residentSessions.values()]
    .filter((session) => !session.disposed && !session.auxiliaryOwner && !hasResidentWork(session))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  const evicted = candidates[0];
  if (evicted) {
    disposeResidentSession(evicted, 'evicted for capacity');
    return;
  }
  throw new AppError(
    `Codex is already keeping ${limit} conversations alive. `
    + 'Wait for one of them to finish, or close the conversations you do not need.',
    { code: 'CODEX_RESIDENT_CAPACITY', statusCode: 409 },
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
  if (closedAdmission.has(options.appSessionId) || (options.auxiliaryWorker && closedAdmission.has(options.auxiliaryWorker.ownerAppSessionId))) {
    throw new Error('The Codex conversation is being closed and cannot take another message.');
  }
  const existing = residentSessions.get(options.appSessionId);
  if (existing && !existing.disposed && (existing.lifetime === 'turn'
    || (options.reserveForRound && (existing.reservedForRound || existing.round))
    || (options.lifetime === 'turn' && hasResidentWork(existing)))) {
    throw new AppError('The Codex conversation is busy; the tool result has not been submitted.', {
      code: 'CODEX_SESSION_BUSY', statusCode: 409,
    });
  }
  if (existing && !existing.disposed && options.lifetime === 'turn') {
    options = { ...options, nativeThreadId: options.nativeThreadId ?? existing.threadId };
    // A thread can only be resumed by one process at a time, so the process
    // that holds it has to be gone before the new one takes it over.
    const released = existing.connection?.waitForExit?.() ?? null;
    disposeResidentSession(existing, 'idle process replaced for a tool-result turn');
    if (released) {
      const gone = await Promise.race([released.then(() => true), sleep(PROCESS_EXIT_WAIT_MS).then(() => false)]);
      if (!gone) {
        console.warn(
          `[Codex] The replaced process of ${options.appSessionId} did not exit in time; the thread may stay locked.`,
        );
      }
    }
  }
  if (existing && !existing.disposed) {
    if (options.reserveForRound) existing.reservedForRound = true;
    existing.lastUsedAt = Date.now();
    // The latest borrower's callbacks describe the current state of the
    // conversation, so they replace the ones of the previous borrower.
    existing.onEngineEvent = options.onEngineEvent ?? existing.onEngineEvent;
    existing.onSessionExit = options.onSessionExit ?? existing.onSessionExit;
    existing.onSessionRequest = options.onSessionRequest ?? existing.onSessionRequest;
    existing.onRoundEnded = options.onRoundEnded ?? existing.onRoundEnded;
    existing.onSessionDisposed = options.onSessionDisposed ?? existing.onSessionDisposed;
    existing.isBusy = options.isBusy ?? existing.isBusy;
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
        if (options.reserveForRound) settled.reservedForRound = true;
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
          get nativeName() { return settled.nativeName; },
        };
      }
      console.log(
        `[Codex] The conversation of ${options.appSessionId} moved to another thread or user; the resident process is replaced.`,
      );
      disposeResidentSession(settled, 'the thread or the user changed');
    }
  }

  // The process that held this thread before must be gone before the new one
  // resumes it.
  const previousExit = releasedProcessExits.get(options.appSessionId);
  if (previousExit) {
    releasedProcessExits.delete(options.appSessionId);
    const gone = await Promise.race([
      previousExit.then(() => true),
      sleep(PROCESS_EXIT_WAIT_MS).then(() => false),
    ]);
    if (!gone) {
      console.warn(
        `[Codex] The previous process of ${options.appSessionId} did not exit in time; the thread may stay locked.`,
      );
    }
  }

  if (!options.auxiliaryWorker) evictResidentSessionIfNeeded();

  const session: ResidentSession = {
    appSessionId: options.appSessionId,
    userId: options.userId ?? null,
    generation: ++nextProcessGeneration,
    lifetime: options.lifetime ?? 'session',
    reservedForRound: options.reserveForRound ?? false,
    connection: undefined as unknown as CodexAppServerConnection,
    threadId: '',
    nativeName: null,
    auxiliaryOwner: options.auxiliaryWorker?.ownerAppSessionId ?? null,
    auxiliaryTargetThreadId: options.auxiliaryWorker?.nativeThreadId ?? null,
    round: null,
    engineTurns: new Set<string>(),
    pendingRequests: 0,
    auxThreads: new Map(),
    auxiliaryThreadIds: new Set(),
    auxiliaryStarting: 0,
    auxiliarySources: new Set(),
    auxiliaryAnnouncements: new Map(),
    pendingTurns: new Map(),
    latestPendingTurnKey: null,
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
      { experimentalApi: true, ...(processSetup ? { env: processSetup.env } : {}), ...(options.auxiliaryWorker ? { inheritEnv: false } : {}) },
    );
    if (session.disposed) {
      connection.close();
      throw new Error('The Codex conversation was closed during initialization.');
    }
    session.connection = connection;
    const threadConfig = options.config ? await options.config(connection) : {};
    if (session.disposed) {
      throw new Error('The Codex conversation was closed during initialization.');
    }
    const thread = await connection.call(
      options.nativeThreadId && !options.auxiliaryWorker ? 'thread/resume' : 'thread/start',
      {
        ...(options.nativeThreadId ? { threadId: options.nativeThreadId, excludeTurns: true } : {}),
        cwd: options.workingDirectory,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.auxiliaryWorker ? 'read-only' : options.sandbox,
        config: threadConfig,
        ...(options.auxiliaryWorker ? { ephemeral: true, threadSource: 'cloudcli_title_worker', dynamicTools: [], environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [] } : {}),
      },
    ) as { thread?: { id?: unknown; name?: unknown } } | undefined;
    if (session.disposed) {
      throw new Error('The Codex conversation was closed during initialization.');
    }
    const threadId = typeof thread?.thread?.id === 'string' ? thread.thread.id : '';
    if (!threadId) {
      throw new Error('Codex app-server opened no thread to run the session in.');
    }
    session.threadId = threadId;
    session.nativeName = typeof thread?.thread?.name === 'string' && thread.thread.name.trim() ? thread.thread.name.trim() : null;
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
      get nativeName() { return settled.nativeName; },
    };
  } catch (error) {
    disposeResidentSession(session, 'initialization failed');
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
  if (options.generation !== undefined && session.generation !== options.generation) {
    throw new Error('The Codex process generation was replaced before submission.');
  }
  if (session.round) {
    throw new Error('The Codex conversation is already answering.');
  }
  if (options.toolOutput && session.lifetime !== 'turn') {
    throw new Error('Tool results require an exclusive one-shot Codex process.');
  }
  if (closedAdmission.has(options.appSessionId)) {
    throw new Error('The Codex conversation is being closed and cannot take another message.');
  }
  if (session.initializing) {
    await session.initializing;
  }
  if (session.disposed || residentSessions.get(options.appSessionId) !== session) {
    throw new Error('The Codex process generation was replaced before submission.');
  }

  const clientUserMessageId = randomUUID();
  let finishSubmission!: () => void;
  const submitted = new Promise<void>((resolve) => { finishSubmission = resolve; });
  const round: ResidentRound = {
    clientUserMessageId,
    queuedItemId: null,
    submitted,
    directSubmission: Boolean(options.toolOutput),
    stopping: null,
    stopTimer: null,
    terminalSeen: false,
    armed: false,
    turnId: null,
    onEvent: options.onEvent,
    onRequest: options.onRequest,
  };
  session.round = round;
  session.reservedForRound = false;
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

    if (options.toolOutput) {
      // This protocol only queues user input. Refuse known engine work before
      // injecting a native tool result, and bind only the returned turn id.
      if (session.engineTurns.size > 0 || session.pendingTurns.size > 0 || session.pendingRequests > 0 || session.isBusy()) {
        throw new AppError('The Codex thread is busy reporting; the tool result was not submitted.', {
          code: 'CODEX_SESSION_BUSY', statusCode: 409,
        });
      }
      const started = await session.connection.call('turn/start', {
        threadId: session.threadId, input: [], toolOutput: options.toolOutput,
      }) as { turn?: { id?: unknown } } | undefined;
      if (session.disposed || session.round !== round) throw new Error('The Codex conversation is closed.');
      const turnId = typeof started?.turn?.id === 'string' ? started.turn.id : null;
      if (!turnId || session.engineTurns.has(turnId)) {
        session.onRoundEnded('unknown');
        throw new Error('Codex could not identify an independent tool-result turn.');
      }
      round.turnId = turnId;
      const waiting = [...session.pendingTurns.values()];
      session.pendingTurns.clear();
      for (const pending of waiting) {
        for (const event of pending.events) {
          if (pending.turnId === turnId) deliverRoundEvent(round, event.method, event.params);
          else deliverEngineEvent(session, event.method, event.params);
        }
      }
      return { clientUserMessageId };
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
  } finally {
    finishSubmission();
  }
}

/**
 * Stops the round of a session.
 *
 * A round that already started is interrupted; a round that is still queued is
 * removed from the queue, which is the only way to cancel it.
 */
export function stopCodexResidentRound(appSessionId: string): Promise<ResidentStopResult> {
  const session = residentSessions.get(appSessionId);
  const round = session?.round;
  if (!session || session.disposed || !round) return Promise.resolve('not-found');
  round.stopping ??= stopResidentRound(session, round);
  return round.stopping;
}

/** Only the captured round may be failed by its own stop timeout. */
function forceUnknownStop(session: ResidentSession, round: ResidentRound, error: unknown, cause: 'stop' | 'interrupt'): void {
  if (session.disposed || session.round !== round || round.terminalSeen) return;
  console.warn(`[Codex] Stop of ${session.appSessionId} is unknown; forcing process exit:`, error);
  session.onRoundEnded('unknown', cause);
  disposeResidentSession(session, 'stop could not be confirmed');
}

async function interruptResidentRound(session: ResidentSession, round: ResidentRound): Promise<ResidentStopResult> {
  if (!round.stopTimer) {
    round.stopTimer = setTimeout(() => forceUnknownStop(session, round,
      new Error('No terminal event arrived after the interrupt.'), 'interrupt'), STOP_CONFIRMATION_MS);
    round.stopTimer.unref?.();
  }
  try {
    await session.connection.call('turn/interrupt', { threadId: session.threadId, turnId: round.turnId }, { timeoutMs: STOP_CONFIRMATION_MS });
    return 'interrupted';
  } catch (error) {
    forceUnknownStop(session, round, error, 'interrupt');
    return round.terminalSeen ? 'not-found' : 'unknown';
  }
}

async function stopResidentRound(session: ResidentSession, round: ResidentRound): Promise<ResidentStopResult> {
  const appSessionId = session.appSessionId;
  let deadline: NodeJS.Timeout | undefined;
  try {
    if (!round.turnId && !round.queuedItemId) await Promise.race([
      round.submitted,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Submission did not settle before stopping.')), STOP_CONFIRMATION_MS);
      }),
    ]);
  } catch (error) {
    forceUnknownStop(session, round, error, 'stop');
    return 'unknown';
  } finally {
    clearTimeout(deadline);
  }
  if (session.disposed || session.round !== round) return 'not-found';
  if (round.turnId) return interruptResidentRound(session, round);
  if (round.queuedItemId) {
    try {
      const withdrawal = await session.connection.call('thread/queue/delete', {
        threadId: session.threadId,
        queuedSubmissionId: round.queuedItemId,
      }, { timeoutMs: STOP_CONFIRMATION_MS }) as { deleted?: unknown } | undefined;
      if (session.disposed || session.round !== round) return 'not-found';
      if (withdrawal?.deleted !== true) {
        if (round.turnId) {
          return interruptResidentRound(session, round);
        }
        throw new Error('The engine did not confirm removal of the queued input.');
      }
    } catch (error) {
      forceUnknownStop(session, round, error, 'stop');
      return 'unknown';
    }
  }
  session.round = null;
  if (!publishPendingEngineTurns(session)) return 'unknown';
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
export function completeCodexResidentRound(
  appSessionId: string,
  expected?: { generation: number; clientUserMessageId: string },
): void {
  const session = residentSessions.get(appSessionId);
  if (!session || (expected && (session.generation !== expected.generation
    || session.round?.clientUserMessageId !== expected.clientUserMessageId))) {
    return;
  }
  if (session.round?.stopTimer) clearTimeout(session.round.stopTimer);
  session.round = null;
  publishPendingEngineTurns(session);
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
export function releaseCodexResidentSession(appSessionId: string, options?: { dispose?: boolean; generation?: number }): void {
  const session = residentSessions.get(appSessionId);
  if (!session || (options?.generation !== undefined && session.generation !== options.generation)) {
    return;
  }
  if (options?.dispose) {
    disposeResidentSession(session, 'released');
    return;
  }
  session.reservedForRound = false;
  session.lastUsedAt = Date.now();
  scheduleResidentReclaim(session);
}

/**
 * What the engine is doing with the session's round.
 *
 * Only the engine knows whether it has picked the queued input up, so the
 * host asks here instead of guessing from the round's existence. A round that
 * exists but has no turn yet is waiting in the engine's queue; a turn the
 * engine started on its own is a background report.
 */
export function readCodexResidentSessionActivity(appSessionId: string): {
  /** The round was submitted and the engine has not started its turn yet. */
  queued: boolean;
  /** The engine is running a turn of its own, such as a background report. */
  reporting: boolean;
} | null {
  const session = residentSessions.get(appSessionId);
  if (!session || session.disposed) {
    return null;
  }
  const round = session.round;
  if (!round) {
    return { queued: false, reporting: session.engineTurns.size > 0 };
  }
  return {
    // The round waits while its input is still in the engine's queue. A round
    // that went in through `turn/start` was never queued, and a round the
    // engine has already picked up is running.
    queued: !round.directSubmission && !round.armed && !round.turnId && !round.terminalSeen,
    reporting: session.engineTurns.size > 0,
  };
}

/**
 * Sessions whose engine runs a report turn of its own with no round of the
 * user's in flight. The running-sessions poll lists a session by its chat run
 * or its agents, so without these a report that follows the last agent's end
 * would stream into a conversation the page shows as idle.
 *
 * Consumer: the Codex runtime's `listBackgroundWork`, which leaves out the
 * sessions its agents already list.
 */
export function listCodexReportingOnlySessions(): string[] {
  const sessions: string[] = [];
  for (const [appSessionId, session] of residentSessions) {
    if (!session.disposed && !session.round && session.engineTurns.size > 0) {
      sessions.push(appSessionId);
    }
  }
  return sessions;
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
  return (!!session && !session.disposed && hasResidentWork(session))
    || [...residentSessions.values()].some((worker) => worker.auxiliaryOwner === appSessionId && !worker.disposed && hasResidentWork(worker));
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
  for (const worker of [...residentSessions.values()]) {
    if (worker.auxiliaryOwner === appSessionId) disposeResidentSession(worker, 'owning conversation closed');
  }
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

/** The only global RPCs exposed to auxiliary borrowers are configuration/catalog reads. */
const AUXILIARY_GLOBAL_READS = new Set(['model/list', 'config/read']);
const AUXILIARY_THREAD_METHODS = new Set(['turn/start', 'turn/interrupt', 'thread/unsubscribe', 'thread/read', 'thread/name/set']);

/** The methods an auxiliary handle may call on a thread other than its own: reading and naming it. */
const AUXILIARY_CROSS_THREAD_METHODS = new Set(['thread/read', 'thread/name/set']);

/**
 * What a caller supplies to borrow an ephemeral thread of a resident session.
 *
 * Consumer: `codex-thread-title.ts` (the Codex thread title client).
 */
export type CodexAuxiliaryThreadOptions = {
  /** The app session whose resident process lends the thread. */
  appSessionId: string;
  /** The process generation the caller saw; a replaced process refuses the borrow. */
  generation?: number;
  /** The `thread/start` parameters of the lent thread. `ephemeral` must be true. */
  start: AnyRecord;
  /** Deadline left for thread/start; the title client owns the overall deadline. */
  timeoutMs?: number;
  /** Every notification of the lent thread. */
  onNotification: (method: string, params: AnyRecord) => void;
  /** Answers a request the engine makes for the lent thread; absent, the request is refused. */
  onRequest?: (method: string, params: AnyRecord) => unknown | Promise<unknown>;
  /** Called when the process goes away under the borrow. */
  onDisposed?: (reason: string) => void;
};

/**
 * A borrowed ephemeral thread.
 *
 * The handle has no `close()`: the process is the conversation's, not the
 * borrower's. `release()` only hands the thread back; interrupting its turn
 * and unsubscribing from it are the borrower's job before that.
 *
 * Consumer: `codex-thread-title.ts` (the Codex thread title client).
 */
export type CodexAuxiliaryThread = {
  /** Actual engine startup result, used to validate sandbox/profile before inference. */
  startResult: AnyRecord;
  appSessionId: string;
  generation: number;
  threadId: string;
  /** Calls app-server for the lent thread; another thread may only be read or named. */
  call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  /** Hands the thread back. Idempotent; a no-op once the process is gone. */
  release(): void;
};

function auxiliaryUnavailable(message: string): AppError {
  return new AppError(message, { code: 'CODEX_AUXILIARY_UNAVAILABLE', statusCode: 409 });
}

/**
 * Lends an ephemeral thread of the resident process of an app session.
 *
 * The borrow does not touch the conversation: the session-level callbacks
 * stay the runtime's, the lent thread's events and requests go to the
 * borrower only, and while the thread is lent the process counts as busy, so
 * it is neither reclaimed nor evicted nor archived under the borrower.
 *
 * Startup announcements identify unclaimed threads even when the start RPC
 * times out. Their source marker keeps auxiliary announcements off the chat
 * path; unclaimed threads are unsubscribed once all starts have settled.
 * The borrower starts its turn after this call returns.
 *
 * Consumer: `codex-thread-title.ts` (the Codex thread title client).
 */
export async function borrowCodexAuxiliaryThread(options: CodexAuxiliaryThreadOptions): Promise<CodexAuxiliaryThread> {
  const session = residentSessions.get(options.appSessionId);
  if (!session || session.disposed || session.initializing) {
    throw auxiliaryUnavailable('No resident Codex conversation is open to lend a thread from.');
  }
  if (session.lifetime === 'turn') {
    throw auxiliaryUnavailable('A one-shot Codex process is exclusive to its turn and lends no thread.');
  }
  if (typeof options.generation === 'number' && options.generation !== session.generation) {
    throw auxiliaryUnavailable('The resident Codex process was replaced; borrow the thread again.');
  }
  if (closedAdmission.has(options.appSessionId) || (session.auxiliaryOwner && closedAdmission.has(session.auxiliaryOwner))) {
    throw auxiliaryUnavailable('The Codex conversation is being closed and lends no thread.');
  }
  if (options.start.ephemeral !== true) {
    throw new AppError('An auxiliary thread must be started ephemeral.', {
      code: 'CODEX_AUXILIARY_NOT_EPHEMERAL', statusCode: 400,
    });
  }

  const source = typeof options.start.threadSource === 'string' && options.start.threadSource.length > 0
    ? options.start.threadSource : 'cloudcli_auxiliary';
  session.auxiliarySources.add(source);
  session.auxiliaryStarting += 1;
  scheduleResidentReclaim(session);
  try {
    const started = await session.connection.call(
      'thread/start',
      { ...options.start, ephemeral: true, threadSource: source },
      { timeoutMs: options.timeoutMs },
    ) as AnyRecord | undefined;
    if (session.disposed) {
      throw auxiliaryUnavailable('The Codex conversation closed while the auxiliary thread was starting.');
    }
    const thread = started?.thread && typeof started.thread === 'object' ? started.thread as AnyRecord : null;
    const threadId = typeof thread?.id === 'string' && thread.id.length > 0 ? thread.id : '';
    if (!threadId) {
      throw auxiliaryUnavailable('Codex app-server opened no auxiliary thread.');
    }

    session.auxiliaryAnnouncements.delete(threadId);
    session.auxiliaryThreadIds.add(threadId);
    session.auxThreads.set(threadId, {
      failed: false,
      onNotification: options.onNotification,
      onRequest: options.onRequest,
      onDisposed: options.onDisposed,
    });
    session.lastUsedAt = Date.now();
    scheduleResidentReclaim(session);

    return {
      startResult: started!,
      appSessionId: session.appSessionId,
      generation: session.generation,
      threadId,
      call: (method, params, callOptions) => callForAuxiliaryThread(session, threadId, method, params, callOptions),
      release: () => {
        if (session.auxThreads.delete(threadId)) {
          session.lastUsedAt = Date.now();
          scheduleResidentReclaim(session);
        }
      },
    };
  } finally {
    session.auxiliaryStarting -= 1;
    detachUnclaimedAuxiliaryThreads(session);
    scheduleResidentReclaim(session);
  }
}

/** A timed-out/abandoned turn/start may still succeed; only its own turn is stopped. */
async function stopLateAuxiliaryTurn(session: ResidentSession, threadId: string, result: unknown): Promise<void> {
  const turn = result && typeof result === 'object' ? (result as AnyRecord).turn as AnyRecord | undefined : undefined;
  const turnId = typeof turn?.id === 'string' ? turn.id : null;
  if (!turnId || session.disposed) return;
  session.pendingRequests += 1;
  scheduleResidentReclaim(session);
  try {
    try { await session.connection.call('turn/interrupt', { threadId, turnId }, { timeoutMs: 1500 }); }
    catch { console.warn(`[CodexTitle] ${session.appSessionId} ${threadId} late_interrupt_failed`); }
    try { await session.connection.call('thread/unsubscribe', { threadId }, { timeoutMs: 1500 }); }
    catch { console.warn(`[CodexTitle] ${session.appSessionId} ${threadId} late_unsubscribe_failed`); }
  } finally {
    session.pendingRequests -= 1;
    scheduleResidentReclaim(session);
  }
}

/**
 * The borrower's calls, kept to its own thread.
 *
 * Opening or taking over threads is refused outright; a call that names
 * another thread passes only when it reads or names that thread, which is
 * what a title borrower needs for the conversation's own thread.
 */
async function callForAuxiliaryThread(
  session: ResidentSession,
  threadId: string,
  method: string,
  params: unknown,
  callOptions?: { timeoutMs?: number },
): Promise<unknown> {
  const record = params && typeof params === 'object' ? params as AnyRecord : {};
  const target = record.threadId;
  const globalRead = AUXILIARY_GLOBAL_READS.has(method);
  const validTarget = typeof target === 'string' && target.length > 0
    && (target === threadId || (target === (session.auxiliaryTargetThreadId ?? session.threadId) && AUXILIARY_CROSS_THREAD_METHODS.has(method)));
  if ((!globalRead && (!AUXILIARY_THREAD_METHODS.has(method) || !validTarget))
    || 'thread_id' in record || 'thread' in record) {
    throw new AppError(`An auxiliary thread cannot call ${method} outside its scope.`, {
      code: 'CODEX_AUXILIARY_THREAD_SCOPE', statusCode: 403,
    });
  }
  if (session.disposed || !session.auxThreads.has(threadId)) {
    throw auxiliaryUnavailable('The auxiliary thread is no longer lent.');
  }
  const result = await session.connection.call(method, params, {
    ...callOptions,
    ...(method === 'turn/start' ? { onLateResult: (late: unknown) => stopLateAuxiliaryTurn(session, threadId, late) } : {}),
  });
  if (method === 'turn/start' && !session.auxThreads.has(threadId)) await stopLateAuxiliaryTurn(session, threadId, result);
  if (method === 'thread/name/set' && target === (session.auxiliaryTargetThreadId ?? session.threadId) && typeof record.name === 'string') session.nativeName = record.name.trim() || null;
  return result;
}

/**
 * Title service/client preflight reads on an already resident process, without
 * acquiring the conversation again or replacing its callbacks. Thread reads
 * are bound to the manager's native thread and process generation.
 */
export async function readCodexResidentMetadata(input: {
  appSessionId: string; generation: number; method: 'thread/read' | 'config/read';
  workingDirectory: string; timeoutMs: number;
}): Promise<unknown> {
  const session = residentSessions.get(input.appSessionId);
  if (!session || session.disposed || session.initializing || session.generation !== input.generation
    || closedAdmission.has(input.appSessionId) || (session?.auxiliaryOwner && closedAdmission.has(session.auxiliaryOwner))) throw auxiliaryUnavailable('The Codex title target is no longer resident.');
  const result = await session.connection.call(input.method, input.method === 'thread/read'
    ? { threadId: session.auxiliaryTargetThreadId ?? session.threadId, includeTurns: false }
    : { cwd: input.workingDirectory, includeLayers: false }, { timeoutMs: input.timeoutMs });
  if (input.method === 'thread/read') {
    const thread = (result as { thread?: { name?: unknown } } | null)?.thread;
    session.nativeName = typeof thread?.name === 'string' && thread.name.trim() ? thread.name.trim() : null;
  }
  return result;
}

/**
 * The title scheduler uses a transient managed worker when the completed chat
 * used a short connection. It creates no stored thread and never resumes the
 * formal conversation; read/name calls are scoped to its native target.
 * The scheduler must dispose the returned key in finally, including late init.
 */
export async function createCodexTitleWorker(target: CodexSessionTitleTarget, deadline: number, signal: AbortSignal): Promise<{ key: string; generation: number }> {
  const key = `codex-title-worker-${randomUUID()}`;
  signal.throwIfAborted();
  const stopInitializing = () => releaseCodexResidentSession(key, { dispose: true });
  signal.addEventListener('abort', stopInitializing, { once: true });
  const env = { ...process.env };
  for (const name of CODEX_HOST_CREDENTIAL_ENV_NAMES) delete env[name];
  try {
    const worker = await acquireCodexResidentSession({
      appSessionId: key, nativeThreadId: null, workingDirectory: target.workingDirectory,
      auxiliaryWorker: { ownerAppSessionId: target.appSessionId, nativeThreadId: target.nativeThreadId, deadline },
      sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'never',
      env: () => ({ env }), isBusy: () => true,
      config: async (connection) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw auxiliaryUnavailable('The title worker startup deadline expired.');
        const effective = await connection.call('config/read', { cwd: target.workingDirectory, includeLayers: false }, { timeoutMs: remaining }) as AnyRecord | null;
        return buildCodexTitleIsolationConfig(effective?.config);
      },
    });
    signal.throwIfAborted();
    return { key, generation: worker.generation };
  } finally { signal.removeEventListener('abort', stopInitializing); }
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

import type { ChildProcess } from 'node:child_process';
import net from 'node:net';

import crossSpawn from 'cross-spawn';

import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { OPENCODE_SERVER_RESPONSE_TIMEOUT_MS, openCodeFetch } from './opencode-http.client.js';

/**
 * HTTP/SSE client for the OpenCode server (`opencode serve`).
 *
 * The OpenCode CLI's non-interactive `run` mode cannot surface tool
 * permissions: any `ask` rule is auto-rejected by the CLI itself, so the chat
 * has no way to render an approval card. The server exposes the primitives the
 * TUI uses instead — a session/message API, a `/global/event` event stream, and
 * `permission`/`question` reply endpoints — which this module drives.
 *
 * One server process is shared by every OpenCode run in the app. Requests carry
 * the target project through `?directory=`; events arrive on the single
 * `/global/event` stream wrapped in a `GlobalEvent` envelope, so the runtime
 * routes each payload to its run by `sessionID`.
 *
 * Consumers: `opencode-runtime.provider.js` (run/abort) and
 * `opencode-permission-bridge.ts` (approval cards).
 */

export type OpenCodeServerHandle = {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
};

/** One server event, unwrapped from the `/global/event` envelope. */
export type OpenCodeServerEvent = {
  readonly type: string;
  readonly properties: AnyRecord;
  readonly directory: string | null;
};

const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_IDLE_SHUTDOWN_MS = 60_000;
const SERVER_HEALTH_TIMEOUT_MS = 3_000;
const STREAM_RECONNECT_DELAY_MS = 1_000;
const SESSION_STATUS_TIMEOUT_MS = 15_000;
const SESSION_IDLE_POLL_INTERVAL_MS = 1_500;

/**
 * How long the shared server may sit idle before shutdown, and how often a
 * shutdown that had to be deferred because the engine still reports work in
 * flight is re-checked.
 */
const SERVER_BUSY_RECHECK_MS = 60_000;

/**
 * Ceiling on how long the idle shutdown keeps yielding to a busy engine.
 *
 * The engine's own turns can legitimately run for hours after the client run
 * ended (a failed run leaves the engine working), and killing the server mid
 * turn destroys that work — the failure this guard exists for. The cap only
 * exists so a truly wedged engine cannot pin a node process forever; hitting
 * it is logged loudly.
 */
const SERVER_BUSY_DEFER_MAX_MS = 6 * 60 * 60_000;

/** Longest an async prompt delivery may wait for its 204 before giving up. */
const ASYNC_PROMPT_ACCEPT_TIMEOUT_MS = 60_000;

/**
 * Directories whose sessions the idle shutdown must check before killing the
 * server. Kept small — the probe walks them on every deferred check.
 */
const SERVER_PROBE_DIRECTORY_LIMIT = 6;

type ServerState = {
  process: ChildProcess;
  baseUrl: string;
  headers: Record<string, string>;
  subscribers: Set<(event: OpenCodeServerEvent) => void>;
  refCount: number;
  idleTimer: NodeJS.Timeout | null;
  streamAbort: AbortController;
  /** Rolling tail of the child's stderr, logged when the process dies unexpectedly. */
  stderr: { tail: string };
  /** Set while we stop the server on purpose, so its exit is not reported as a crash. */
  stopping: boolean;
  /**
   * Directories seen on recent requests/events (path → last-seen epoch ms).
   * The idle shutdown probes each one's `/session/status` before killing the
   * server: a run ending is not proof the engine stopped working — a failed
   * run's turn can still be in flight, and a busy engine must not be killed.
   */
  recentDirectories: Map<string, number>;
  /** When the current idle-shutdown deferral began; null while not deferred. */
  idleDeferStartedAt: number | null;
};

let serverState: ServerState | null = null;
let serverStarting: Promise<ServerState> | null = null;

/** Picks a free loopback port for the shared server. */
function reserveLoopbackPort(): Promise<number> {
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
        reject(new Error('Could not reserve a loopback port for the OpenCode server.'));
      });
    });
  });
}

/** Basic-auth header for `opencode serve` when the user secured it. */
function openCodeServerAuthHeaders(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    return {};
  }

  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

function buildUrl(baseUrl: string, path: string, directory: string | null): string {
  if (!directory) {
    return `${baseUrl}${path}`;
  }
  const separator = path.includes('?') ? '&' : '?';
  return `${baseUrl}${path}${separator}directory=${encodeURIComponent(directory)}`;
}

/**
 * Records a directory a request or event touched, so the idle shutdown knows
 * which project instances may still have engine work in flight.
 *
 * Consumers: `requestJson` (every call carries `?directory=`) and
 * `dispatchEventChunk` (the global envelope names the event's directory).
 */
function noteServerDirectory(state: ServerState | null, directory: string | null): void {
  if (!state || !directory) {
    return;
  }
  state.recentDirectories.set(directory, Date.now());
  if (state.recentDirectories.size > 24) {
    const oldest = [...state.recentDirectories.entries()].sort((a, b) => a[1] - b[1]).slice(0, state.recentDirectories.size - 24);
    for (const [key] of oldest) {
      state.recentDirectories.delete(key);
    }
  }
}

/** The most recently touched directories, capped for the idle-shutdown probe. */
function recentProbeDirectories(state: ServerState): string[] {
  return [...state.recentDirectories.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SERVER_PROBE_DIRECTORY_LIMIT)
    .map(([directory]) => directory);
}

async function waitForServer(baseUrl: string, headers: Record<string, string>, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode server exited before it was ready (code ${child.exitCode}).`);
    }

    try {
      const response = await openCodeFetch(`${baseUrl}/global/health`, {
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

async function consumeOpenCodeServerEventStream(state: ServerState): Promise<void> {
  let response: Response;
  try {
    response = await openCodeFetch(`${state.baseUrl}/global/event`, {
      headers: { accept: 'text/event-stream', ...state.headers },
      signal: state.streamAbort.signal,
    });
  } catch {
    return;
  }

  if (!response.ok || !response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatchEventChunk(state, chunk);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch {
    // Cancelled at shutdown, or the connection dropped; the loop reconnects.
  }
}

/**
 * Keeps the shared event stream connected for the server's lifetime.
 *
 * The stream is the only channel for live output; a single dropped connection
 * used to end live updates silently while runs stayed "in progress". Reconnect
 * until the server is stopped or replaced. opencode does not replay past events
 * on a new connection, so a gap is possible but a duplicate never is.
 */
async function readOpenCodeServerEventStream(state: ServerState): Promise<void> {
  while (!state.streamAbort.signal.aborted && !state.stopping) {
    await consumeOpenCodeServerEventStream(state);
    if (state.streamAbort.signal.aborted || state.stopping) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, STREAM_RECONNECT_DELAY_MS));
  }
}

function dispatchEventChunk(state: ServerState, chunk: string): void {
  const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) {
    return;
  }

  let envelope: AnyRecord;
  try {
    envelope = JSON.parse(dataLine.slice(5).trim()) as AnyRecord;
  } catch {
    return;
  }

  const payload = readObjectRecord(envelope.payload) ?? envelope;
  const type = readOptionalString(payload.type);
  if (!type) {
    return;
  }

  const event: OpenCodeServerEvent = {
    type,
    properties: readObjectRecord(payload.properties) ?? {},
    directory: readOptionalString(envelope.directory) ?? null,
  };

  noteServerDirectory(state, event.directory);

  for (const subscriber of state.subscribers) {
    try {
      subscriber(event);
    } catch {
      // One misbehaving run must not stop delivery to the others.
    }
  }
}

/**
 * Force-terminates the shared server and every process underneath it.
 *
 * On Windows `cross-spawn` launches `opencode` through a `cmd.exe` wrapper, so
 * the child handle points at `cmd.exe` and a plain `kill` would orphan the real
 * `opencode.exe` and its MCP children. `taskkill /T` walks that tree; POSIX
 * needs only the direct child.
 *
 * Consumers: `startOpenCodeServer` (failed startup), `releaseOpenCodeServer`
 * (idle shutdown), and `shutdownOpenCodeServer` (server shutdown/tests).
 */
function killOpenCodeServerProcess(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      crossSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch {
      // Fall through to the direct kill below.
    }
  }

  try {
    child.kill();
  } catch {
    // Already gone.
  }
}

/**
 * Reads the underlying reason out of undici's opaque `fetch failed` error.
 *
 * Node's global `fetch` reports every transport-level failure with the same
 * `TypeError: fetch failed` message and stores the real condition on
 * `error.cause` — a `DOMException` for aborts, or a system error carrying a
 * `code` such as `ECONNREFUSED` or `UND_ERR_SOCKET`. Without digging the cause
 * out, a dead server, a dropped socket and a failed lookup all read as the same
 * unhelpful string in the logs and in the chat UI.
 */
function readFetchFailureCause(error: Error): string | null {
  const cause = error.cause;
  if (!cause) {
    return null;
  }
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code) {
      return code;
    }
    return cause.name && cause.name !== 'Error' ? cause.name : cause.message || null;
  }
  return typeof cause === 'string' ? cause : null;
}

/**
 * Rewrites any exception from a request against the shared server into an error
 * whose message explains the failure, keeping the original as its cause.
 *
 * The runtime and the chat gateway render `error.message` verbatim, so the bare
 * `fetch failed` undici emits left users and logs with no way to tell a dead
 * server from a dropped connection.
 *
 * Consumers: `requestJson` (every session/message/permission call).
 */
function describeRequestFailure(method: string, path: string, error: unknown): Error {
  const context = `OpenCode server ${method} ${path}`;
  if (!(error instanceof Error)) {
    return new Error(`${context} failed: ${String(error)}`);
  }

  if (error.message === 'fetch failed') {
    const cause = readFetchFailureCause(error);
    const detail = cause ? ` (${cause})` : '';
    return new Error(`${context} could not reach the local OpenCode server${detail}.`, { cause: error });
  }

  if (error.name === 'TimeoutError') {
    return new Error(`${context} timed out before the turn finished.`, { cause: error });
  }

  return new Error(`${context} failed: ${error.message}`, { cause: error });
}

/**
 * Probes the shared server's health endpoint.
 *
 * Consumers: `acquireOpenCodeServer` (reuse check) and `opencode-runtime.provider.js`
 * (deciding whether a failed status read means a transport blip or a dead
 * server while it waits for a turn to settle). Reusing a handle that points at
 * a process which died without its child `exit` event firing (on Windows the
 * `cmd.exe` shim can outlive the real `opencode.exe`) would fail the next
 * request with `fetch failed`; probing first lets the caller restart instead.
 */
export async function isOpenCodeServerReachable(handle: OpenCodeServerHandle): Promise<boolean> {
  try {
    const response = await openCodeFetch(`${handle.baseUrl}/global/health`, {
      headers: handle.headers,
      signal: AbortSignal.timeout(SERVER_HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Forgets and force-kills the shared server.
 *
 * Consumers: `acquireOpenCodeServer` (stale health probe), `releaseOpenCodeServer`
 * (idle shutdown) and `shutdownOpenCodeServer` (process shutdown).
 */
function discardOpenCodeServerState(state: ServerState): void {
  state.stopping = true;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (serverState === state) {
    serverState = null;
  }
  state.streamAbort.abort();
  killOpenCodeServerProcess(state.process);
}

async function startOpenCodeServer(): Promise<ServerState> {
  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', ...openCodeServerAuthHeaders() };
  const child = crossSpawn('opencode', ['serve', '--port', String(port)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    // Windows routes `opencode` through a `cmd.exe` wrapper (it is a `.cmd`
    // shim); without this every launch pops an interactive console window.
    windowsHide: true,
  });

  // Drain both pipes: an unread stream back-pressures the child and stalls it.
  child.stdout?.on('data', () => {});
  const stderr = { tail: '' };
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.tail = (stderr.tail + chunk.toString()).slice(-2000);
  });

  try {
    await waitForServer(baseUrl, headers, child);
  } catch (error) {
    killOpenCodeServerProcess(child);
    const detail = stderr.tail.trim() ? `: ${stderr.tail.trim().split('\n').slice(-3).join(' | ')}` : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  }

  const state: ServerState = {
    process: child,
    baseUrl,
    headers,
    subscribers: new Set(),
    refCount: 0,
    idleTimer: null,
    streamAbort: new AbortController(),
    stderr,
    stopping: false,
    recentDirectories: new Map(),
    idleDeferStartedAt: null,
  };

  void readOpenCodeServerEventStream(state);

  child.once('exit', (code, signal) => {
    if (serverState === state) {
      serverState = null;
    }
    state.streamAbort.abort();
    if (state.stopping) {
      return;
    }
    const detail = stderr.tail.trim();
    const suffix = detail ? ` stderr: ${detail.split('\n').slice(-3).join(' | ')}` : '';
    console.warn(
      `[OpenCode] Shared server exited unexpectedly (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).${suffix}`,
    );
  });

  return state;
}

/**
 * Starts the shared server if needed and pins it against idle shutdown for the
 * duration of one run. Always pair with `releaseOpenCodeServer`.
 *
 * An existing server is health-probed before reuse so a child that died without
 * emitting `exit` is replaced rather than handed out for a doomed request.
 */
export async function acquireOpenCodeServer(): Promise<OpenCodeServerHandle> {
  const existing = serverState;
  if (existing) {
    const responsive = await isOpenCodeServerReachable(existing);
    // A failed probe only proves the server is gone when nothing is using it:
    // an in-flight run pins `refCount`, and a busy server can still miss a short
    // health timeout without being dead. Killing it there would abort a healthy
    // turn, so reuse it and let the run's own request report any real failure.
    if (responsive || existing.refCount > 0) {
      if (!responsive) {
        console.warn('[OpenCode] Shared server missed a health probe while a run is active; keeping it.');
      }
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      existing.idleDeferStartedAt = null;
      existing.refCount += 1;
      return { baseUrl: existing.baseUrl, headers: existing.headers };
    }
    // Idle handle that no longer answers: the process died without its child
    // `exit` event firing (on Windows the `cmd.exe` shim can outlive the real
    // `opencode.exe`). Drop it so the request below starts a fresh server.
    discardOpenCodeServerState(existing);
  }

  if (!serverStarting) {
    serverStarting = startOpenCodeServer();
  }

  let state: ServerState;
  try {
    state = await serverStarting;
  } finally {
    serverStarting = null;
  }

  serverState = state;
  state.refCount += 1;
  return { baseUrl: state.baseUrl, headers: state.headers };
}

/** What an idle-shutdown probe learned about the engine's in-flight work. */
export type OpenCodeServerWorkState = 'idle' | 'busy' | 'unknown' | 'unreachable';

/**
 * Asks the engine whether any session in the given directories still has work
 * in flight, via the per-directory `/session/status` map.
 *
 * The idle shutdown consults this before killing the server: the end of a
 * client run is not proof the turn is over — a run whose client failed leaves
 * the engine executing with nobody watching, and killing it there destroyed
 * real work (a training command) in the field. `idle` is the only state that
 * permits the shutdown; `busy` and `unknown` (a failed query on a reachable
 * server) defer it, while `unreachable` means the server is gone and the kill
 * is mere cleanup. Consumers: `attemptOpenCodeServerIdleShutdown`; tests probe
 * it directly.
 */
export async function probeOpenCodeServerWork(
  handle: OpenCodeServerHandle,
  directories: readonly string[],
): Promise<OpenCodeServerWorkState> {
  let sawFailure = false;
  for (const directory of directories) {
    try {
      const response = await openCodeFetch(buildUrl(handle.baseUrl, '/session/status', directory), {
        headers: handle.headers,
        signal: AbortSignal.timeout(SERVER_HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) {
        sawFailure = true;
        continue;
      }
      const record = readObjectRecord(await response.json().catch(() => null));
      for (const value of Object.values(record ?? {})) {
        const type = readOptionalString(readObjectRecord(value)?.type);
        if (type === 'busy' || type === 'retry') {
          return 'busy';
        }
      }
    } catch {
      sawFailure = true;
    }
  }

  if (!sawFailure) {
    return 'idle';
  }
  return (await isOpenCodeServerReachable(handle)) ? 'unknown' : 'unreachable';
}

/**
 * Kills the shared server once it stays idle, unless the engine still reports
 * work in flight for a recently touched directory.
 *
 * The deferral exists because a run can end while its turn is still executing
 * (its client failed, or a later turn was queued): the engine must be allowed
 * to finish, and only its settling to idle — or the deferral ceiling — ends
 * the wait. Consumers: the idle timer set by `releaseOpenCodeServer`.
 */
async function attemptOpenCodeServerIdleShutdown(state: ServerState): Promise<void> {
  state.idleTimer = null;
  if (serverState !== state || state.refCount > 0 || state.stopping) {
    return;
  }

  const directories = recentProbeDirectories(state);
  const work = directories.length > 0
    ? await probeOpenCodeServerWork({ baseUrl: state.baseUrl, headers: state.headers }, directories)
    : 'idle';

  // The probe awaited; a run may have pinned the server again meanwhile.
  if (serverState !== state || state.refCount > 0 || state.stopping) {
    return;
  }

  if (work === 'busy' || work === 'unknown') {
    const deferStartedAt = state.idleDeferStartedAt ?? Date.now();
    if (state.idleDeferStartedAt === null) {
      console.warn(
        `[OpenCode] Shared server is idle but the engine still reports work in flight (${work}); keeping it alive until the turn finishes.`,
      );
      state.idleDeferStartedAt = deferStartedAt;
    }
    if (Date.now() - deferStartedAt >= SERVER_BUSY_DEFER_MAX_MS) {
      console.warn('[OpenCode] Busy engine did not settle within the shutdown deferral window; killing the shared server anyway.');
      discardOpenCodeServerState(state);
      return;
    }
    state.idleTimer = setTimeout(() => {
      void attemptOpenCodeServerIdleShutdown(state);
    }, SERVER_BUSY_RECHECK_MS);
    state.idleTimer.unref?.();
    return;
  }

  discardOpenCodeServerState(state);
}

/** Drops one run's hold on the shared server; idle servers shut down later. */
export function releaseOpenCodeServer(): void {
  const state = serverState;
  if (!state) {
    return;
  }

  state.refCount = Math.max(0, state.refCount - 1);
  if (state.refCount > 0 || state.idleTimer) {
    return;
  }

  state.idleDeferStartedAt = null;
  state.idleTimer = setTimeout(() => {
    void attemptOpenCodeServerIdleShutdown(state);
  }, SERVER_IDLE_SHUTDOWN_MS);
  state.idleTimer.unref?.();
}

/** Subscribes to the shared event stream; returns an unsubscribe function. */
export function subscribeOpenCodeEvents(handler: (event: OpenCodeServerEvent) => void): () => void {
  const state = serverState;
  if (!state) {
    return () => {};
  }
  state.subscribers.add(handler);
  return () => {
    state.subscribers.delete(handler);
  };
}

async function requestJson(
  handle: OpenCodeServerHandle,
  method: 'POST' | 'GET',
  path: string,
  directory: string | null,
  body: unknown,
  timeoutMs = OPENCODE_SERVER_RESPONSE_TIMEOUT_MS,
): Promise<unknown> {
  const url = buildUrl(handle.baseUrl, path, directory);
  if (serverState && serverState.baseUrl === handle.baseUrl) {
    noteServerDirectory(serverState, directory);
  }
  let response: Response;
  try {
    response = await openCodeFetch(url, {
      method,
      headers: handle.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw describeRequestFailure(method, path, error);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const suffix = detail.trim() ? `: ${detail.trim().slice(0, 300)}` : '';
    const error = new Error(`OpenCode server ${method} ${path} failed (HTTP ${response.status})${suffix}`);
    (error as { status?: number }).status = response.status;
    throw error;
  }

  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Maps a UI permission mode onto the OpenCode agent the run should use.
 * `plan` is OpenCode's built-in read-only agent; the other modes keep the
 * caller's configured agent (default `build`).
 */
export function resolveOpenCodeAgent(permissionMode: string | undefined): string | undefined {
  return permissionMode === 'plan' ? 'plan' : undefined;
}

/**
 * Permission actions `acceptEdits` approves without asking, mirroring the
 * `{ edit: "allow" }` override the runtime used to pass to the CLI.
 */
const OPENCODE_EDIT_ACTIONS = new Set(['edit', 'write', 'patch']);

/**
 * Whether a permission request must be approved without asking the user.
 * `bypassPermissions` mirrors `opencode run --auto`: every request that is not
 * explicitly denied is answered `once` immediately. `acceptEdits` auto-approves
 * file-editing actions only; anything else still renders a card.
 */
export function shouldAutoApproveOpenCodePermission(
  permissionMode: string | undefined,
  permission?: string | null,
): boolean {
  if (permissionMode === 'bypassPermissions') {
    return true;
  }
  return permissionMode === 'acceptEdits'
    && typeof permission === 'string'
    && OPENCODE_EDIT_ACTIONS.has(permission);
}

/** Creates a provider-side session and returns its `ses_…` id. */
export async function createOpenCodeSession(
  handle: OpenCodeServerHandle,
  directory: string,
  model: { providerId: string; modelId: string } | null,
  agent: string | undefined,
): Promise<string> {
  const body: AnyRecord = {};
  if (model) {
    body.model = { id: model.modelId, providerID: model.providerId };
  }
  if (agent) {
    body.agent = agent;
  }

  const created = await requestJson(handle, 'POST', '/session', directory, body);
  const id = readOptionalString(readObjectRecord(created)?.id);
  if (!id) {
    throw new Error('OpenCode did not return a session id.');
  }
  return id;
}

/**
 * Reads one session's `parentID`, or null when it has no parent (or the
 * session is gone).
 *
 * Subagent (task-tool) sessions record the session that spawned them in
 * `parentID`, which the permissions bridge walks to decide whether an approval
 * raised inside a child session belongs to a run. Consumers:
 * `opencode-permissions.provider.ts`.
 */
export async function readOpenCodeSessionParentId(
  handle: OpenCodeServerHandle,
  directory: string,
  sessionId: string,
): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await requestJson(
      handle,
      'GET',
      `/session/${encodeURIComponent(sessionId)}`,
      directory,
      undefined,
      SESSION_STATUS_TIMEOUT_MS,
    );
  } catch (error) {
    // A vanished session is a fact about ownership, not a transport failure.
    if ((error as { status?: number }).status === 404) {
      return null;
    }
    throw error;
  }
  return readOptionalString(readObjectRecord(payload)?.parentID) ?? null;
}

/**
 * Forks one session, returning the new provider-native session id.
 *
 * The endpoint's cut is exclusive: it copies the messages that precede
 * `messageId`, and the whole conversation when it is omitted. Callers that want
 * a turn-inclusive cut must pass the id of the message *after* the anchor.
 */
export async function forkOpenCodeSession(
  handle: OpenCodeServerHandle,
  directory: string,
  sessionId: string,
  messageId?: string | null,
): Promise<string> {
  const body: AnyRecord = messageId ? { messageID: messageId } : {};
  const created = await requestJson(
    handle,
    'POST',
    `/session/${encodeURIComponent(sessionId)}/fork`,
    directory,
    body,
    60_000,
  );

  const id = readOptionalString(readObjectRecord(created)?.id);
  if (!id) {
    throw new Error('OpenCode did not return a session id for the fork.');
  }
  return id;
}

/** One prompt's text, model, agent and effort, in the shape both sends take. */
export type OpenCodePromptInput = {
  text: string;
  model: { providerId: string; modelId: string } | null;
  agent?: string;
  variant?: string;
};

/** Builds the prompt body the blocking and async send endpoints both expect. */
function buildPromptBody(input: OpenCodePromptInput): AnyRecord {
  const body: AnyRecord = {
    parts: [{ type: 'text', text: input.text }],
  };
  if (input.model) {
    body.model = { providerID: input.model.providerId, modelID: input.model.modelId };
  }
  if (input.agent) {
    body.agent = input.agent;
  }
  if (input.variant) {
    body.variant = input.variant;
  }
  return body;
}

/**
 * Sends one user turn with the blocking endpoint and resolves when the whole
 * assistant turn completes. Live output arrives through the event stream
 * meanwhile.
 *
 * Kept for engines whose server predates `prompt_async`; the runtime prefers
 * `sendOpenCodeMessageAsync`, because binding a multi-hour turn to one held
 * request was the source of the old timeout failure mode.
 */
export async function sendOpenCodeMessage(
  handle: OpenCodeServerHandle,
  directory: string,
  sessionId: string,
  input: OpenCodePromptInput,
): Promise<void> {
  await requestJson(handle, 'POST', `/session/${encodeURIComponent(sessionId)}/message`, directory, buildPromptBody(input));
}

/** Error code marking the fallback marker for engines without `prompt_async`. */
export const OPENCODE_ASYNC_PROMPT_UNSUPPORTED = 'OPENCODE_ASYNC_PROMPT_UNSUPPORTED';

/** Servers (by base URL) whose `prompt_async` endpoint answered 404/405. */
const asyncPromptUnsupportedServers = new Set<string>();

/**
 * Whether this server is expected to expose `prompt_async`. A server only
 * enters the negative set after actually answering 404/405, and servers get a
 * fresh loopback port on restart, so a stale entry cannot outlive the process
 * it describes in any way that matters.
 */
export function openCodeServerSupportsAsyncPrompt(handle: OpenCodeServerHandle): boolean {
  return !asyncPromptUnsupportedServers.has(handle.baseUrl);
}

/** Whether `error` is the marker thrown for a server without `prompt_async`. */
export function isOpenCodeAsyncPromptUnsupportedError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === OPENCODE_ASYNC_PROMPT_UNSUPPORTED;
}

function asyncPromptUnsupportedError(): Error {
  const error = new Error('This OpenCode server has no async prompt endpoint; use the blocking message endpoint instead.');
  (error as { code?: string }).code = OPENCODE_ASYNC_PROMPT_UNSUPPORTED;
  return error;
}

/**
 * Delivers one prompt without waiting for the turn: the engine answers
 * 204 ("Prompt accepted") in milliseconds and the turn's progress and
 * completion are observed through the event stream and `/session/status`.
 *
 * This is the healthy delivery path for long turns — the request itself lives
 * for milliseconds, so no client-side deadline can cut a multi-hour turn
 * short, and a transport hiccup after acceptance cannot end the turn either.
 * Consumers: `opencode-runtime.provider.js` (`spawnOpenCode` and
 * `injectOpenCodeInput`), with `sendOpenCodeMessage` as the fallback for older
 * engines.
 */
export async function sendOpenCodeMessageAsync(
  handle: OpenCodeServerHandle,
  directory: string,
  sessionId: string,
  input: OpenCodePromptInput,
): Promise<void> {
  if (asyncPromptUnsupportedServers.has(handle.baseUrl)) {
    throw asyncPromptUnsupportedError();
  }

  try {
    await requestJson(
      handle,
      'POST',
      `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      directory,
      buildPromptBody(input),
      ASYNC_PROMPT_ACCEPT_TIMEOUT_MS,
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 405) {
      asyncPromptUnsupportedServers.add(handle.baseUrl);
      throw asyncPromptUnsupportedError();
    }
    throw error;
  }
}

/** The engine's view of one session: idle, running a turn, or retrying a failed one. */
export type OpenCodeSessionStatus = 'idle' | 'busy' | 'retry';

/**
 * Reads the engine's status for one session, or null when it is not tracked.
 *
 * The engine lists only sessions with work in flight: a finished session drops
 * out of the map entirely, so `null` means "no running turn", not "unknown".
 *
 * Consumers: `opencode-runtime.provider.js`, to decide whether a run whose
 * blocking prompt request dropped is still executing and should keep waiting.
 */
export async function getOpenCodeSessionStatus(
  handle: OpenCodeServerHandle,
  directory: string | null,
  sessionId: string,
): Promise<OpenCodeSessionStatus | null> {
  const payload = await requestJson(handle, 'GET', '/session/status', directory, undefined, SESSION_STATUS_TIMEOUT_MS);
  const record = readObjectRecord(payload);
  const status = readOptionalString(readObjectRecord(record?.[sessionId])?.type);
  return status === 'idle' || status === 'busy' || status === 'retry' ? status : null;
}

/** Consecutive failed status reads tolerated while the server still answers its health probe. */
const SESSION_STATUS_FAILURE_TOLERANCE = 5;

/**
 * Blocks until the session stops running, polling the engine for its status.
 *
 * A finished session leaves the status map instead of flipping to `idle`
 * (verified against the engine: only sessions with work in flight are listed),
 * so both `idle` and an untracked (`null`) session mean the run is over. The
 * null case is what used to keep the poll spinning until the one-hour deadline
 * — the engine had finished, but the gateway never saw the run end.
 *
 * There is no deadline by default: turns legitimately run for hours, and a
 * client-side cap only produced false failures for work the engine was still
 * doing. A failed status read is retried while the server answers its health
 * probe, and only rethrown when the server is truly gone — that is a real
 * failure the caller must surface. The runtime's settle loops embed the same
 * poll and also wake on idle events; this is the direct, unit-tested form of
 * the status contract. Consumers: tests.
 */
export async function waitForOpenCodeSessionIdle(
  handle: OpenCodeServerHandle,
  directory: string | null,
  sessionId: string,
  timeoutMs = 0,
): Promise<void> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  let consecutiveFailures = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, SESSION_IDLE_POLL_INTERVAL_MS));
    let status: OpenCodeSessionStatus | null;
    try {
      status = await getOpenCodeSessionStatus(handle, directory, sessionId);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= SESSION_STATUS_FAILURE_TOLERANCE || !(await isOpenCodeServerReachable(handle))) {
        throw error;
      }
      continue;
    }
    if (status === null || status === 'idle') {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`OpenCode session ${sessionId} did not finish within the wait window.`);
    }
  }
}

/** Requests cancellation of the running turn for one session. */
export async function abortOpenCodeSession(
  handle: OpenCodeServerHandle,
  directory: string,
  sessionId: string,
): Promise<void> {
  try {
    await requestJson(handle, 'POST', `/session/${encodeURIComponent(sessionId)}/abort`, directory, undefined, 15_000);
  } catch {
    // A run that already finished has nothing to abort.
  }
}

/**
 * Marks a session reverted at `messageId`: that message and everything after it
 * is dropped the next time a prompt is sent. Used by the edit flow, where the
 * replacement turn must not be appended to the conversation it replaces.
 */
export async function revertOpenCodeSession(
  handle: OpenCodeServerHandle,
  directory: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  await requestJson(
    handle,
    'POST',
    `/session/${encodeURIComponent(sessionId)}/revert`,
    directory,
    { messageID: messageId },
    30_000,
  );
}

/** Answers one pending permission request. Returns false if it was already gone. */
export async function replyOpenCodePermission(
  handle: OpenCodeServerHandle,
  directory: string,
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<boolean> {
  try {
    const body: AnyRecord = { reply };
    if (message) {
      body.message = message;
    }
    await requestJson(handle, 'POST', `/permission/${encodeURIComponent(requestId)}/reply`, directory, body, 15_000);
    return true;
  } catch {
    return false;
  }
}

/** Answers a pending question request; `answers` is one label array per question. */
export async function replyOpenCodeQuestion(
  handle: OpenCodeServerHandle,
  directory: string,
  requestId: string,
  answers: string[][],
): Promise<boolean> {
  try {
    await requestJson(handle, 'POST', `/question/${encodeURIComponent(requestId)}/reply`, directory, { answers }, 15_000);
    return true;
  } catch {
    return false;
  }
}

/** Rejects a pending question request (the user skipped it). */
export async function rejectOpenCodeQuestion(
  handle: OpenCodeServerHandle,
  directory: string,
  requestId: string,
): Promise<boolean> {
  try {
    await requestJson(handle, 'POST', `/question/${encodeURIComponent(requestId)}/reject`, directory, undefined, 15_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tears the shared server down immediately, cancelling its idle timer.
 *
 * Consumers: the server entrypoint (server/index.ts) during shutdown, so a
 * restart does not leave `opencode serve` (and its taskkill-invisible children)
 * running, plus tests that need a clean slate.
 */
export function shutdownOpenCodeServer(): void {
  const state = serverState;
  serverState = null;
  serverStarting = null;
  if (!state) {
    return;
  }
  discardOpenCodeServerState(state);
}

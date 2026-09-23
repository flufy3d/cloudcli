/**
 * A rolling record of what the client sent and received, for diagnosing what
 * the transcript ended up showing.
 *
 * Every round of "the session died" or "the message is duplicated" has been
 * diagnosed from the *engine's* transcript on disk — which can only ever prove
 * what the engine saw. It cannot show a row the client invented, a frame that
 * arrived twice, or a stop the user never pressed. This records exactly that:
 * every websocket frame in both directions, summarized to the fields row
 * identity is decided by.
 *
 * It is always on, and it survives a reload. Both matter for the same reason:
 * a report you have to enable first, or that a refresh wipes, is a report you
 * do not have the one time you need it — by the time anyone thinks to export
 * one, the tab that saw the incident has usually been refreshed. The buffer is
 * bounded and each entry keeps only field summaries, never full bodies.
 *
 * Consumers: `WebSocketContext` (records both directions) and
 * `diagnosticsReport` (folds the frames into the exported report).
 */

/** How many frames to keep in memory. One busy turn is a few hundred. */
const MAX_RECORDED_FRAMES = 4000;

/**
 * How many frames follow the tab across a reload. Smaller than the in-memory
 * buffer on purpose: this is serialized to sessionStorage on a timer, and the
 * recent past is what a report is read for.
 */
const MAX_PERSISTED_FRAMES = 1500;

/** Longest text kept per entry, so a report stays readable and small. */
const MAX_SUMMARY_LENGTH = 120;

const STORAGE_KEY = 'cloudcli-diagnostic-frames-v1';

/** How long writes are batched, so a burst of deltas is one serialization. */
const PERSIST_DEBOUNCE_MS = 2_000;

export type RecordedFrame = {
  /** Milliseconds since the page loaded, so ordering survives a clock change. */
  at: number;
  wallClock: string;
  direction: 'in' | 'out';
  sessionId: string | null;
  /** `kind` for a server frame, `type` for a client request. */
  kind: string;
  /**
   * Which page load recorded the frame. Frames restored after a reload keep
   * the id of the load that produced them, so a report taken in a fresh tab
   * still shows where the reload boundary is.
   */
  load: string;
  /** The row identity the frame carries, when it carries one. */
  id?: string;
  toolId?: string;
  role?: string;
  seq?: number;
  /** First characters of whatever the frame's payload is, for recognizing it. */
  summary?: string;
};

const frames: RecordedFrame[] = [];

/** Identifies this page load in every frame it records. */
const currentLoadId = Math.random().toString(36).slice(2, 10);

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function truncate(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) {
    return undefined;
  }
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH)}…` : text;
}

function readSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Storage access throws outright in some embedded and private-mode browsers.
    return null;
  }
}

/**
 * Writes the recent frames where a reload can find them.
 *
 * Consumers: the debounced recorder itself, the `pagehide` handler (a reload
 * gives no second chance), and the tests that simulate a reload.
 */
export function persistRecordedFrames(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const storage = readSessionStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(frames.slice(-MAX_PERSISTED_FRAMES)));
  } catch {
    // A full quota must never break the app the recorder is only watching.
  }
}

function schedulePersist(): void {
  if (persistTimer || typeof setTimeout === 'undefined') {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistRecordedFrames();
  }, PERSIST_DEBOUNCE_MS);
}

function push(frame: RecordedFrame): void {
  frames.push(frame);
  if (frames.length > MAX_RECORDED_FRAMES) {
    frames.splice(0, frames.length - MAX_RECORDED_FRAMES);
  }
  schedulePersist();
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecordedFrame(value: unknown): value is RecordedFrame {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const frame = value as Partial<RecordedFrame>;
  return typeof frame.kind === 'string'
    && typeof frame.wallClock === 'string'
    && (frame.direction === 'in' || frame.direction === 'out');
}

/**
 * Loads the frames an earlier page load left behind, in front of this load's.
 *
 * Consumers: the module's own initialization, and the tests that simulate a
 * reload. Malformed storage is dropped: a diagnostics buffer must never be
 * able to break the page it is only observing.
 */
export function restoreRecordedFrames(): void {
  const storage = readSessionStorage();
  if (!storage) {
    return;
  }

  let restored: RecordedFrame[] = [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    restored = Array.isArray(parsed) ? parsed.filter(isRecordedFrame) : [];
  } catch {
    restored = [];
  }

  if (restored.length === 0) {
    return;
  }

  frames.unshift(...restored.slice(-MAX_PERSISTED_FRAMES));
  if (frames.length > MAX_RECORDED_FRAMES) {
    frames.splice(0, frames.length - MAX_RECORDED_FRAMES);
  }
}

/**
 * Records one frame the server sent. Called from the websocket's `onmessage`
 * before the frame is dispatched, so the log shows arrival order even when a
 * listener throws.
 */
export function recordInboundFrame(frame: unknown): void {
  if (!frame || typeof frame !== 'object') {
    return;
  }
  const record = frame as Record<string, unknown>;
  const seq = record.seq;
  push({
    at: Math.round(typeof performance === 'undefined' ? 0 : performance.now()),
    wallClock: new Date().toISOString(),
    direction: 'in',
    sessionId: readString(record, 'sessionId') ?? null,
    kind: readString(record, 'kind') ?? 'unknown',
    load: currentLoadId,
    id: readString(record, 'id'),
    toolId: readString(record, 'toolId'),
    role: readString(record, 'role'),
    seq: typeof seq === 'number' ? seq : undefined,
    summary: truncate(record.content ?? record.error ?? record.text),
  });
}

/** Records one request the client sent, before it reaches the socket. */
export function recordOutboundFrame(message: unknown): void {
  if (!message || typeof message !== 'object') {
    return;
  }
  const record = message as Record<string, unknown>;
  push({
    at: Math.round(typeof performance === 'undefined' ? 0 : performance.now()),
    wallClock: new Date().toISOString(),
    direction: 'out',
    sessionId: readString(record, 'sessionId') ?? null,
    kind: readString(record, 'type') ?? 'unknown',
    load: currentLoadId,
    summary: truncate(record.content),
  });
}

/**
 * Empties the buffer.
 *
 * `keepStorage` exists for the reload test: a reload clears memory while
 * sessionStorage survives, and that asymmetry is the behavior under test.
 * Every other caller means "forget this", which must include what a reload
 * would bring back.
 */
export function resetRecordedFrames(options: { keepStorage?: boolean } = {}): void {
  frames.length = 0;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (options.keepStorage) {
    return;
  }
  try {
    readSessionStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Same unavailable-storage fallback as writes.
  }
}

/** The frames recorded so far, oldest first. Consumer: the report builder. */
export function readRecordedFrames(): readonly RecordedFrame[] {
  return frames;
}

if (typeof window !== 'undefined') {
  restoreRecordedFrames();
  // A reload is the common case and gives no second chance to flush.
  window.addEventListener('pagehide', () => persistRecordedFrames());
}

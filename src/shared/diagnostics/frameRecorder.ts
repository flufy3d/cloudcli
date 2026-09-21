/**
 * A rolling record of what the client sent and received, for diagnosing what
 * the transcript ended up showing.
 *
 * Duplicated messages are the recurring failure in this app, and every round
 * of it has been diagnosed from the *engine's* transcript on disk — which can
 * only ever prove what the engine saw. It cannot show a row the client
 * invented, a frame that arrived twice, or a send the server refused. This
 * records exactly that: every websocket frame in both directions, summarized
 * to the fields row identity is decided by, plus whatever the timeline held
 * when the report was taken.
 *
 * It is always on. The buffer is bounded and each entry keeps only field
 * summaries — never full message bodies — so leaving it running costs a few
 * hundred kilobytes and asks nothing of the user before the bug happens,
 * which is the whole point: a report you have to enable first is a report you
 * do not have the one time you need it.
 *
 * Consumers: `WebSocketContext` (records both directions) and
 * `ChatExportMenu` (writes the report out).
 */

import type { NormalizedMessage } from '@/shared/types';

/** How many frames to keep. One busy turn is a few hundred. */
const MAX_RECORDED_FRAMES = 4000;

/** Longest text kept per entry, so a report stays readable and small. */
const MAX_SUMMARY_LENGTH = 120;

export type RecordedFrame = {
  /** Milliseconds since the page loaded, so ordering survives a clock change. */
  at: number;
  wallClock: string;
  direction: 'in' | 'out';
  sessionId: string | null;
  /** `kind` for a server frame, `type` for a client request. */
  kind: string;
  /** The row identity the frame carries, when it carries one. */
  id?: string;
  toolId?: string;
  role?: string;
  seq?: number;
  /** First characters of whatever the frame's payload is, for recognizing it. */
  summary?: string;
};

const frames: RecordedFrame[] = [];

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

function push(frame: RecordedFrame): void {
  frames.push(frame);
  if (frames.length > MAX_RECORDED_FRAMES) {
    frames.splice(0, frames.length - MAX_RECORDED_FRAMES);
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
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
  push({
    at: Math.round(performance.now()),
    wallClock: new Date().toISOString(),
    direction: 'in',
    sessionId: readString(record, 'sessionId') ?? null,
    kind: readString(record, 'kind') ?? readString(record, 'type') ?? 'unknown',
    id: readString(record, 'id'),
    toolId: readString(record, 'toolId'),
    role: readString(record, 'role'),
    seq: typeof record.seq === 'number' ? record.seq : undefined,
    summary: truncate(record.content ?? record.text ?? record.error ?? record.toolName),
  });
}

/** Records one request the client sent. */
export function recordOutboundFrame(message: unknown): void {
  if (!message || typeof message !== 'object') {
    return;
  }
  const record = message as Record<string, unknown>;
  push({
    at: Math.round(performance.now()),
    wallClock: new Date().toISOString(),
    direction: 'out',
    sessionId: readString(record, 'sessionId') ?? null,
    kind: readString(record, 'type') ?? 'unknown',
    summary: truncate(record.content),
  });
}

/** What the timeline held for one session when the report was taken. */
export type TimelineSnapshot = {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  retiredOptimisticUserAnchors: Array<[string, string]>;
  pendingPrompts: Array<[string, unknown]>;
  runEnded: boolean;
};

export type DiagnosticsReport = {
  takenAt: string;
  sessionId: string | null;
  /** Both directions, oldest first. */
  frames: RecordedFrame[];
  /** The rows of the session being reported on, as the store holds them. */
  timeline: {
    /** Merged rows in render order, reduced to what identifies them. */
    rendered: Array<Pick<NormalizedMessage, 'id' | 'kind' | 'role' | 'toolId'> & { summary?: string }>;
    server: string[];
    realtime: string[];
    retiredOptimisticUserAnchors: Array<[string, string]>;
    runEnded: boolean;
  } | null;
};

/**
 * Builds the report. `timeline` is optional because the recorder must stay
 * usable from anywhere, including before a session is open.
 */
export function buildDiagnosticsReport(
  sessionId: string | null,
  rendered: NormalizedMessage[] | null,
  snapshot: TimelineSnapshot | null,
): DiagnosticsReport {
  return {
    takenAt: new Date().toISOString(),
    sessionId,
    frames: [...frames],
    timeline: rendered && snapshot
      ? {
        rendered: rendered.map((row) => ({
          id: row.id,
          kind: row.kind,
          role: row.role,
          toolId: row.toolId,
          summary: truncate(row.content),
        })),
        server: snapshot.serverMessages.map((row) => row.id),
        realtime: snapshot.realtimeMessages.map((row) => row.id),
        retiredOptimisticUserAnchors: snapshot.retiredOptimisticUserAnchors,
        runEnded: snapshot.runEnded,
      }
      : null,
  };
}

/**
 * How the report reaches the timeline it describes.
 *
 * The store is created per app mount rather than as a module singleton, so
 * the report cannot import it. The mount registers a reader instead, and the
 * export control asks for the session it is showing.
 *
 * Consumers: `useSessionStore` registers, `downloadDiagnosticsReport` reads.
 */
type TimelineSnapshotSource = (sessionId: string) => {
  rendered: NormalizedMessage[];
  snapshot: TimelineSnapshot;
} | null;

let timelineSnapshotSource: TimelineSnapshotSource | null = null;

export function registerTimelineSnapshotSource(source: TimelineSnapshotSource | null): void {
  timelineSnapshotSource = source;
}

/**
 * Writes the report to a file the user can attach to a bug report.
 *
 * Consumer: `ChatExportMenu`.
 */
export function downloadDiagnosticsReport(sessionId: string | null): void {
  const timeline = sessionId ? timelineSnapshotSource?.(sessionId) ?? null : null;
  const report = buildDiagnosticsReport(sessionId, timeline?.rendered ?? null, timeline?.snapshot ?? null);
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cloudcli-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Test seam: empties the buffer so one test cannot see another's frames. */
export function resetRecordedFrames(): void {
  frames.length = 0;
}

/** The frames recorded so far, oldest first. Consumer: the report builder and its tests. */
export function readRecordedFrames(): readonly RecordedFrame[] {
  return frames;
}

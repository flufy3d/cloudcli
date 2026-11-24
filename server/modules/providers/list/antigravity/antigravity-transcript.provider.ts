import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import type { AnyRecord } from '@/shared/types.js';
import { parseProviderJson, readObjectRecord, sanitizeLeafDirectoryName } from '@/shared/utils.js';

import { getAntigravityTranscriptCandidates } from './antigravity-data-root.js';

type CanonicalAntigravityTranscriptRow = {
  entry: AnyRecord;
  contentCompleteness: 'complete' | 'truncated';
};

function isContentTruncated(entry: AnyRecord): boolean {
  return Array.isArray(entry.truncated_fields) && entry.truncated_fields.includes('content');
}

async function readJsonl(pathname: string): Promise<CanonicalAntigravityTranscriptRow[]> {
  const rows: CanonicalAntigravityTranscriptRow[] = [];
  try {
    const input = fs.createReadStream(pathname);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = readObjectRecord(parseProviderJson(line));
        if (entry) rows.push({ entry, contentCompleteness: isContentTruncated(entry) ? 'truncated' : 'complete' });
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return rows;
}

/**
 * The cross-transport identity of the assistant prose one transcript step
 * holds. Consumers: AntigravitySessionsProvider stamps it on history rows and
 * the print stream's deltas; AntigravityAcpTranslator stamps it on ACP deltas.
 * The frontend retires a live streamed bubble once the persisted row with the
 * same key loads, so both transports must build it here.
 */
export function buildAntigravityAssistantRowKey(stepIndex: number | undefined): string | undefined {
  return stepIndex === undefined ? undefined : `assistant-step:${stepIndex}`;
}

/** Bytes read from the end of the transcript when probing its newest step. */
const LATEST_STEP_TAIL_BYTES = 64 * 1024;

/** Last probe per transcript path; a file whose size has not moved is not re-read. */
const latestStepCache = new Map<string, { size: number; step: number | undefined }>();

/** Highest `step_index` among the complete JSONL lines in `text`. */
function readMaxStepIndex(text: string, skipFirstLine: boolean): number | undefined {
  const lines = text.split('\n');
  let max: number | undefined;
  for (let index = skipFirstLine ? 1 : 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const step = readObjectRecord(JSON.parse(line))?.step_index;
      if (typeof step === 'number' && (max === undefined || step > max)) max = step;
    } catch {
      // A torn tail line or a cut first line: skip it.
    }
  }
  return max;
}

/**
 * The newest `step_index` the engine has written to a session's transcript,
 * or undefined when there is no transcript yet. Consumer:
 * AntigravityAcpTranslator, which predicts the step a streaming reply will be
 * persisted as (ACP frames carry no step index of their own). Synchronous and
 * called per text chunk, so it reads only the file's tail and only when the
 * file has grown; rows can land out of order, hence the max over the window.
 */
export function readLatestAntigravityStepIndex(engineSessionId: string): number | undefined {
  try {
    const safeId = sanitizeLeafDirectoryName(engineSessionId, 'antigravity session id');
    const transcriptPath = getAntigravityTranscriptCandidates(safeId).find((candidate) => fs.existsSync(candidate));
    if (!transcriptPath) return undefined;
    const { size } = fs.statSync(transcriptPath);
    const cached = latestStepCache.get(transcriptPath);
    if (cached && cached.size === size) return cached.step;

    const fd = fs.openSync(transcriptPath, 'r');
    try {
      let length = Math.min(size, LATEST_STEP_TAIL_BYTES);
      let step: number | undefined;
      for (;;) {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        step = readMaxStepIndex(buffer.toString('utf8'), length < size);
        // One oversized row can fill the window without a complete line.
        if (step !== undefined || length >= size) break;
        length = Math.min(size, length * 4);
      }
      latestStepCache.set(transcriptPath, { size, step });
      return step;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // The prediction is an optimization: no key means the bubble stays until reload.
    return undefined;
  }
}

/**
 * Reads Antigravity's compact and full transcript artifacts as one canonical
 * ordered stream. Consumed by AntigravitySessionsProvider to normalize historical
 * turns with exact step identity and content completeness, while this module owns
 * partial writes, corrupt JSONL tails, and the case where the full file has not
 * caught up with compact yet.
 */
export async function readCanonicalAntigravityTranscript(
  sessionId: string,
): Promise<CanonicalAntigravityTranscriptRow[]> {
  const safeId = sanitizeLeafDirectoryName(sessionId, 'antigravity session id');
  const compactPath = getAntigravityTranscriptCandidates(safeId).find((candidate) => fs.existsSync(candidate));
  if (!compactPath) return [];

  const fullPath = path.join(path.dirname(compactPath), 'transcript_full.jsonl');
  const [compactRows, fullRows] = await Promise.all([
    readJsonl(compactPath),
    fs.existsSync(fullPath) ? readJsonl(fullPath) : Promise.resolve([]),
  ]);
  const fullByStep = new Map<number, CanonicalAntigravityTranscriptRow>();
  for (const row of fullRows) {
    if (typeof row.entry.step_index === 'number') fullByStep.set(row.entry.step_index, row);
  }

  const merged: CanonicalAntigravityTranscriptRow[] = [];
  const compactSteps = new Set<number>();
  for (const row of compactRows) {
    const step = row.entry.step_index;
    if (typeof step === 'number') {
      compactSteps.add(step);
      merged.push(fullByStep.get(step) ?? row);
    } else {
      merged.push(row);
    }
  }
  for (const row of fullRows) {
    const step = row.entry.step_index;
    if (typeof step === 'number' && !compactSteps.has(step)) merged.push(row);
  }
  return sortByStepIndex(merged);
}

/**
 * Restores causal order by step index. Antigravity's writer occasionally
 * flushes a tool result row ahead of the call row that produced it, which
 * would otherwise make consumers pair a result with the wrong call. Rows
 * without a native step index carry no ordering of their own, so they keep
 * their position right after the row they followed.
 */
function sortByStepIndex(rows: CanonicalAntigravityTranscriptRow[]): CanonicalAntigravityTranscriptRow[] {
  let previousKey = -1;
  const keyed = rows.map((row, position) => {
    const step = row.entry.step_index;
    previousKey = typeof step === 'number' ? step : previousKey + 0.5;
    return { row, key: previousKey, position };
  });
  keyed.sort((a, b) => (a.key - b.key) || (a.position - b.position));
  return keyed.map(({ row }) => row);
}

import fs from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord, sanitizeLeafDirectoryName } from '@/shared/utils.js';

import { getAntigravityTranscriptCandidates } from './antigravity-data-root.js';

type CanonicalAntigravityTranscriptRow = {
  entry: AnyRecord;
  contentCompleteness: 'complete' | 'truncated';
};

function isContentTruncated(entry: AnyRecord): boolean {
  return Array.isArray(entry.truncated_fields) && entry.truncated_fields.includes('content');
}

async function readJsonl(pathname: string): Promise<CanonicalAntigravityTranscriptRow[]> {
  try {
    const content = await readFile(pathname, 'utf8');
    return content.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const entry = readObjectRecord(JSON.parse(line));
        if (!entry) return [];
        return [{ entry, contentCompleteness: isContentTruncated(entry) ? 'truncated' : 'complete' }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/**
 * Reads Antigravity's compact and full transcript artifacts as one canonical
 * ordered stream. Consumers get native step identity and content completeness,
 * while this module owns partial writes, corrupt JSONL tails, and the case
 * where the full file has not caught up with compact yet.
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
    if (typeof step !== 'number' || !compactSteps.has(step)) merged.push(row);
  }
  // Compact order is the newest writer's causal order. Do not sort it: rows
  // without a native step index still have a meaningful transcript position.
  return merged;
}

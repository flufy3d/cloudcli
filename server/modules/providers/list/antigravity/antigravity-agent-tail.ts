import fs from 'node:fs';

import type { NormalizedMessage } from '@/shared/types.js';
import { sanitizeLeafDirectoryName } from '@/shared/utils.js';

import { getAntigravityTranscriptCandidates } from './antigravity-data-root.js';

type TailOptions = {
  /** The agent's timeline as history reads it, newest state included. */
  readTimeline: (conversationId: string) => Promise<NormalizedMessage[]>;
  /** Receives each step, already tied to the agent's card. */
  emit: (message: NormalizedMessage) => void;
  /** Poll period; `fs.watch` wakes the poll sooner when the transcript changes. */
  intervalMs?: number;
};

type Followed = {
  toolUseId: string;
  /** What was last sent for each step, so only new or changed steps go out again. */
  sent: Map<string, string>;
  timer: NodeJS.Timeout | null;
  watcher: fs.FSWatcher | null;
  reading: Promise<void> | null;
};

const DEFAULT_INTERVAL_MS = 2_000;

/** A step's identity plus whatever can still change on it (a tool call gains its result). */
const fingerprint = (message: NormalizedMessage): string => JSON.stringify([
  message.content ?? null, message.toolResult?.content ?? null, message.toolResult?.isError ?? null,
]);

/**
 * Follows the transcripts of running Antigravity agents and emits their new
 * steps while they work.
 *
 * `agy` streams only the parent's events; an agent's own work is written to
 * its transcript on disk (brain directory, by conversation id). Re-reading that
 * transcript the way history does keeps live and refreshed cards identical:
 * the same rows with the same ids, so a step is sent when it first appears and
 * again only if it changed (its result arrived).
 *
 * Consumer: the Antigravity runtime, one tail per run.
 */
export function createAgentTranscriptTail(options: TailOptions) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const followed = new Map<string, Followed>();
  const rejected = new Set<string>();

  async function poll(conversationId: string, entry: Followed): Promise<void> {
    if (entry.reading) {
      return entry.reading;
    }
    entry.reading = (async () => {
      try {
        const timeline = await options.readTimeline(conversationId);
        for (const message of timeline) {
          // The agent's prompt is the card's task, and run bookkeeping is not a step.
          if (message.kind === 'text' ? message.role === 'user' : message.kind !== 'tool_use' && message.kind !== 'thinking') {
            continue;
          }
          const print = fingerprint(message);
          if (entry.sent.get(message.id) === print) {
            continue;
          }
          entry.sent.set(message.id, print);
          options.emit({ ...message, parentToolUseId: entry.toolUseId });
        }
      } catch (error) {
        console.warn(`[AntigravityAgentTail] Could not read the transcript of agent ${conversationId}:`, error);
      } finally {
        entry.reading = null;
      }
    })();
    return entry.reading;
  }

  function watch(conversationId: string, entry: Followed): void {
    try {
      const safeId = sanitizeLeafDirectoryName(conversationId, 'antigravity session id');
      const transcriptPath = getAntigravityTranscriptCandidates(safeId).find((candidate) => fs.existsSync(candidate));
      if (transcriptPath) {
        entry.watcher = fs.watch(transcriptPath, () => { void poll(conversationId, entry); });
        entry.watcher.on('error', () => entry.watcher?.close());
      }
    } catch {
      // The poll alone still follows the agent; a missing watcher costs only latency.
    }
  }

  return {
    /** Starts following an agent; its steps go to the card named by `toolUseId`. */
    follow(conversationId: string, toolUseId: string): void {
      if (followed.has(conversationId) || rejected.has(conversationId)) {
        return;
      }
      try {
        sanitizeLeafDirectoryName(conversationId, 'antigravity session id');
      } catch (error) {
        // An id that names no transcript directory never will; say so once.
        rejected.add(conversationId);
        console.warn(`[AntigravityAgentTail] Not following agent "${conversationId}": ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const entry: Followed = { toolUseId, sent: new Map(), timer: null, watcher: null, reading: null };
      followed.set(conversationId, entry);
      entry.timer = setInterval(() => { void poll(conversationId, entry); }, intervalMs);
      entry.timer.unref?.();
      watch(conversationId, entry);
      void poll(conversationId, entry);
    },

    /** Ends the follow after one last read, so the agent's final steps are not lost. */
    async stop(conversationId: string): Promise<void> {
      const entry = followed.get(conversationId);
      if (!entry) {
        return;
      }
      if (entry.timer) clearInterval(entry.timer);
      entry.watcher?.close();
      followed.delete(conversationId);
      await entry.reading;
      entry.reading = null;
      await poll(conversationId, entry);
    },

    async stopAll(): Promise<void> {
      await Promise.all([...followed.keys()].map((conversationId) => this.stop(conversationId)));
    },
  };
}

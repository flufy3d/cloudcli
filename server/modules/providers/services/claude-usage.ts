import type { AnyRecord, ProviderTokenUsageResult } from '@/shared/types.js';
import {
  readJsonlIncrementally,
  readObjectRecord,
  readUsageNumber,
  type JsonlIncrementalState,
} from '@/shared/utils.js';

/**
 * Context windows the Claude SDK reported per provider session id.
 *
 * The SDK states the real window of the model that served a turn only in the
 * turn's `result.modelUsage[model].contextWindow`; the transcript records the
 * model id at most, and an id cannot tell a 200K from a 1M variant, nor what a
 * self-hosted model behind ANTHROPIC_BASE_URL allows. Remembering the reported
 * value lets the history-derived usage show the same window the live counter
 * did. It is process memory on purpose: after a restart the counter falls back
 * to CONTEXT_WINDOW until the session's next turn reports again.
 */
const reportedClaudeContextWindows = new Map<string, number>();

/** One number per session; the cap only bounds a long-lived server's memory. */
const MAX_REPORTED_CLAUDE_CONTEXT_WINDOWS = 1000;

/**
 * Used by the Claude runtime provider to record the window the SDK reported for
 * a session's turn. Non-positive or non-numeric values are ignored so a build
 * that reports no window never overwrites one that did.
 */
export function rememberClaudeContextWindow(providerSessionId: string, contextWindow: number): void {
  if (!providerSessionId || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return;
  }

  // Re-insert so the most recently reported sessions are the last evicted.
  reportedClaudeContextWindows.delete(providerSessionId);
  reportedClaudeContextWindows.set(providerSessionId, contextWindow);
  if (reportedClaudeContextWindows.size > MAX_REPORTED_CLAUDE_CONTEXT_WINDOWS) {
    const oldestSessionId = reportedClaudeContextWindows.keys().next().value;
    if (oldestSessionId !== undefined) {
      reportedClaudeContextWindows.delete(oldestSessionId);
    }
  }
}

/**
 * Used by the Claude runtime provider (a resumed run starts from the window its
 * session last reported) and the Claude history reader.
 */
export function getReportedClaudeContextWindow(
  providerSessionId: string | null | undefined,
): number | undefined {
  return providerSessionId ? reportedClaudeContextWindows.get(providerSessionId) : undefined;
}

/** Running totals over one Claude transcript: newest context plus whole spend. */
type ClaudeUsageAccumulator = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  /** Set once the newest compaction boundary is passed: older turns are history. */
  compacted: boolean;
  /** `postTokens` recorded by the newest compaction boundary, when the CLI wrote one. */
  postCompactionTokens: number | null;
  /** Model named by the newest main-thread assistant row, for window resolution. */
  observedModel: string | null;
};

/** Cursors of the transcripts already read; one small object per session. */
const claudeTranscriptCursors = new Map<string, JsonlIncrementalState<ClaudeUsageAccumulator>>();

/** Bounds a long-lived server's memory; the least recently read entry leaves. */
const MAX_CLAUDE_TRANSCRIPT_CURSORS = 200;

function createClaudeUsageAccumulator(): ClaudeUsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    compacted: false,
    postCompactionTokens: null,
    observedModel: null,
  };
}

/**
 * Folds one transcript entry into the running totals.
 *
 * Shared by the pure summarizer (which is handed already-parsed rows) and the
 * incremental file reader, so both apply exactly the same rules.
 */
function applyClaudeUsageEntry(accumulator: ClaudeUsageAccumulator, entry: AnyRecord): void {
  // A compaction boundary marks every assistant row before it as history. The
  // boundary itself may carry `postTokens`: the size of the summary the next
  // request will carry, i.e. the only honest occupancy reading right after a
  // compaction. A newer boundary without one clears the previous reading
  // rather than letting a superseded number stand in for it.
  if (entry?.type === 'system' && entry?.subtype === 'compact_boundary') {
    accumulator.compacted = true;
    accumulator.postCompactionTokens = readCompactionPostTokens(entry);
    return;
  }

  const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
  if (!usage) {
    return;
  }

  const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
  const rowCacheReadTokens = readUsageNumber(
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
  );
  const rowCacheCreationTokens = readUsageNumber(
    usage.cache_creation_input_tokens
      ?? usage.cacheCreationInputTokens
      ?? usage.cacheCreationTokens,
  );
  const rowInputTokens = directInputTokens + rowCacheReadTokens + rowCacheCreationTokens;
  const rowOutputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

  // `<synthetic>` rows — interrupts, API errors, "No response requested" —
  // are written with an all-zero usage block rather than none at all. They
  // never carried a prompt, so counting one zeroed a counter that a live
  // event had just set correctly.
  if (rowInputTokens === 0 && rowOutputTokens === 0) {
    return;
  }

  accumulator.cumulativeInputTokens += rowInputTokens;
  accumulator.cumulativeOutputTokens += rowOutputTokens;

  // A subagent's turns report the subagent's context window, not this
  // conversation's; reading one makes the counter drop to the subagent's
  // number and bounce back on the next main-thread turn. They still count as
  // spend above, and the newest main-thread row wins here.
  if (entry?.isSidechain === true) {
    return;
  }

  const model = entry.message?.model;
  if (typeof model === 'string' && model.length > 0) {
    accumulator.observedModel = model;
  }

  accumulator.cacheReadTokens = rowCacheReadTokens;
  accumulator.cacheCreationTokens = rowCacheCreationTokens;
  accumulator.inputTokens = rowInputTokens;
  accumulator.outputTokens = rowOutputTokens;
  // An assistant turn ran after the boundary, so its own reading is the
  // current context again.
  accumulator.compacted = false;
  accumulator.postCompactionTokens = null;
}

/**
 * Occupancy recorded by one compaction boundary.
 *
 * The transcript writes `compactMetadata.postTokens`; the live stream's
 * boundary carries the same numbers snake-cased. Returns null for a boundary
 * that records no post-compaction reading (older CLIs), which the summarizer
 * reports as `compacted` instead of guessing.
 */
function readCompactionPostTokens(entry: AnyRecord): number | null {
  const metadata = readObjectRecord(entry.compact_metadata ?? entry.compactMetadata);
  const postTokens = readUsageNumber(metadata?.post_tokens ?? metadata?.postTokens);
  return postTokens > 0 ? postTokens : null;
}

function buildClaudeUsageResult(
  accumulator: ClaudeUsageAccumulator,
  sources: ClaudeContextWindowSources,
): ProviderTokenUsageResult {
  const total = resolveClaudeContextWindow(sources, accumulator.observedModel);
  const cacheTokens = accumulator.cacheReadTokens + accumulator.cacheCreationTokens;
  const cumulative = {
    used: accumulator.cumulativeInputTokens + accumulator.cumulativeOutputTokens,
    inputTokens: accumulator.cumulativeInputTokens,
    outputTokens: accumulator.cumulativeOutputTokens,
  };

  if (accumulator.compacted) {
    if (accumulator.postCompactionTokens !== null) {
      return {
        used: accumulator.postCompactionTokens,
        total,
        inputTokens: accumulator.postCompactionTokens,
        outputTokens: 0,
        cumulative,
        breakdown: { input: accumulator.postCompactionTokens, output: 0 },
      };
    }
    return {
      used: 0,
      total,
      inputTokens: 0,
      outputTokens: 0,
      cumulative,
      breakdown: { input: 0, output: 0 },
      compacted: true,
    };
  }

  return {
    used: accumulator.inputTokens + accumulator.outputTokens,
    total,
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheCreationTokens: accumulator.cacheCreationTokens,
    cacheTokens,
    cumulative,
    breakdown: { input: accumulator.inputTokens, output: accumulator.outputTokens },
  };
}

/**
 * Latest context-window usage plus the session's cumulative spend from a
 * Claude transcript's already-parsed rows.
 *
 * Exported because the session-messages reader hands the same usage back on
 * every history page, the way the Codex and OpenCode readers do. Without that,
 * a Claude session's counter only moved when the session was reselected, and
 * the store's "this provider reports no usage" path overwrote it with zero.
 *
 * `used` reads the newest main-thread assistant turn only:
 * `input_tokens + cache_read + cache_creation` is that one request's whole
 * prompt, i.e. what the context window currently holds. Summing turns would
 * count the same cached prefix once per turn, so the cumulative block sums
 * every assistant row instead — subagent turns included, since their tokens
 * were really spent on this session.
 *
 * A compaction boundary newer than every assistant turn replaces that reading
 * with its own `postTokens`: the assistant rows before it describe the context
 * the compaction just discarded, while `postTokens` is exactly what the next
 * request will carry. Newer SDKs report it, so a just-compacted session keeps a
 * real percentage instead of showing the pre-compaction one (or nothing).
 */
export function summarizeClaudeTokenUsage(
  entries: AnyRecord[],
  sources: ClaudeContextWindowSources = {},
): ProviderTokenUsageResult {
  const accumulator = createClaudeUsageAccumulator();
  for (const entry of entries) {
    applyClaudeUsageEntry(accumulator, entry);
  }
  return buildClaudeUsageResult(accumulator, sources);
}

/**
 * Same reading, computed from the transcript file itself and parsing only the
 * bytes appended since the previous call.
 *
 * A Claude transcript reaches hundreds of megabytes while each turn adds a few
 * kilobytes, so replaying the whole file on every usage refresh spends
 * hundreds of milliseconds of parse and GC for nothing. The accumulator keeps
 * the running totals, which is all a refresh needs, and the reader streams the
 * file, so a cold read of a huge transcript never holds it in memory.
 *
 * Consumers: the Claude sessions provider's token-usage endpoint.
 */
export async function readClaudeTranscriptTokenUsage(
  filename: string,
  sources: ClaudeContextWindowSources = {},
): Promise<ProviderTokenUsageResult> {
  const next = await readJsonlIncrementally(
    filename,
    claudeTranscriptCursors.get(filename),
    createClaudeUsageAccumulator,
    applyClaudeUsageEntry,
  );

  if (next) {
    // Re-insert so the most recently read transcripts are the last evicted.
    claudeTranscriptCursors.delete(filename);
    claudeTranscriptCursors.set(filename, next);
    if (claudeTranscriptCursors.size > MAX_CLAUDE_TRANSCRIPT_CURSORS) {
      const oldest = claudeTranscriptCursors.keys().next().value;
      if (oldest !== undefined) {
        claudeTranscriptCursors.delete(oldest);
      }
    }
  }

  return buildClaudeUsageResult(
    next?.accumulator ?? createClaudeUsageAccumulator(),
    sources,
  );
}

/**
 * Everything that can tell us how large a Claude session's context window is,
 * in the order the resolver trusts them.
 *
 * Shared by the transcript readers and the live runtime frames so all three
 * surfaces that publish a token budget — `/token-usage`, every history page,
 * and the per-assistant frame during a run — can never disagree about the
 * window the same session is measured against.
 */
export type ClaudeContextWindowSources = {
  /**
   * Window the SDK reported for this exact session during this process,
   * remembered in memory until a restart. Authoritative when present.
   */
  reported?: number | null;
  /**
   * Window the SDK reported for this exact session, persisted on the app row
   * by `recordClaudeSessionContextWindow`. Authoritative when present.
   */
  recorded?: number | null;
  /** Raw `CONTEXT_WINDOW` deployment override, unparsed. */
  configured?: string | undefined;
  /**
   * Model variant the app recorded for the session (`opus[1m]`). The user's
   * own selection, so it still carries the window tag that the transcript's
   * resolved model id drops.
   */
  selectedModel?: string | null;
};

/**
 * Resolves the context window a session's usage is measured against.
 *
 * Consumers: `summarizeClaudeTokenUsage` above (the two transcript paths) and
 * the Claude runtime provider, for the frames it streams during a run.
 *
 * Precedence, and why:
 *
 * 1. The window the SDK reported for this session, in memory for the current
 *    process or persisted on the app row. It is a measurement of the run that
 *    actually happened, and it is the same number the live `token_budget`
 *    frames carry, so preferring it is what keeps the reload path and the
 *    realtime path in agreement.
 * 2. `CONTEXT_WINDOW`. A deployment-wide override, above the heuristics below
 *    so an operator can still pin a window, and below the measurement above
 *    because a measurement of this session beats a guess about all of them.
 * 3. The model. `[1m]` variants carry the 1M-context beta; every other model
 *    the Claude CLI knows is 200k, while an id that names no Anthropic family
 *    or version (a self-hosted endpoint, e.g. `claude-local`) falls back to
 *    the settings default (160k), which is what `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
 *    sessions are measured against. The session's *selected* model is tried
 *    first because it keeps the tag (`opus[1m]`), which is how a 1M session
 *    reopened before it has run here still reads as 1M; the transcript's model
 *    is the last resort, and it only ever decides anything for transcripts
 *    written outside CloudCLI, since it records the resolved id
 *    (`claude-opus-5`).
 */
export function resolveClaudeContextWindow(
  sources: ClaudeContextWindowSources,
  model: string | null,
): number {
  const reported = sources.reported;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) {
    return reported;
  }

  const recorded = sources.recorded;
  if (typeof recorded === 'number' && Number.isFinite(recorded) && recorded > 0) {
    return recorded;
  }

  const parsedContextWindow = Number.parseInt(sources.configured ?? '', 10);
  if (Number.isFinite(parsedContextWindow) && parsedContextWindow > 0) {
    return parsedContextWindow;
  }

  const taggedModel = [sources.selectedModel, model]
    .find((candidate) => typeof candidate === 'string' && candidate.length > 0);
  if (taggedModel?.includes('[1m]')) {
    return 1_000_000;
  }
  // A row that never names a model gets the current-model default. A known
  // Anthropic family or version (`claude-opus-5`, `claude-3-5-sonnet-…`) is
  // 200k; any other id is a self-hosted endpoint the CLI does not know, which
  // the engine measures against its settings default instead.
  if (!taggedModel || /^claude-(opus|sonnet|haiku|fable|\d)/.test(taggedModel)) {
    return 200_000;
  }
  return 160_000;
}

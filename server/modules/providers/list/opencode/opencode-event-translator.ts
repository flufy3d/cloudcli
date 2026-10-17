/**
 * OpenCode Session Event Translator
 *
 * Turns the service's session-scoped SSE events into the NormalizedMessage
 * frames the chat timeline already understands. Event names and payloads
 * are pinned to what v2.0.31 emits (captured live; see the tests' fixtures):
 *
 * - `session.text.delta` → `stream_delta`; `session.text.ended` → `stream_end`
 * - `session.reasoning.delta` → `thinking` deltas under one stable block id
 *   (the timeline appends same-id thinking frames, so deltas, not totals)
 * - `session.tool.input.started` / `tool.called` → `tool_use` snapshots that
 *   the timeline upserts by toolId; `tool.success` / `tool.failed` → `tool_result`
 * - `session.execution.{succeeded,failed,interrupted}` → run terminal
 *   (`session.step.ended` carries token totals, but the runtime reads the
 *   authoritative session totals from the API snapshot instead)
 *
 * Ids on transcript rows (thinking / tool_use / tool_result) derive from the
 * engine's own identifiers (assistant message id + ordinal, tool call id) so
 * the same record never arrives under two ids. Unknown event types are
 * ignored on purpose: the service is young and adds events between patch
 * releases.
 *
 * @module opencode-event-translator
 */

import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';

const PROVIDER = 'opencode' as const;

//----------------- TRANSLATION RESULTS ------------

/** How a run ended, as reported by `session.execution.*`. */
export type OpenCodeRunOutcome =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'interrupted'; reason: string };

/**
 * Frames to forward plus, on execution-terminal events, how the run ended.
 *
 * Consumer: opencode runtime.
 */
export type OpenCodeTranslatedEvent = {
  frames: NormalizedMessage[];
  terminal?: OpenCodeRunOutcome;
};

/** A tool call the translator has seen; the interaction bridge labels permission cards with it. */
export type OpenCodeToolCall = {
  name: string;
  input: unknown;
};

// ---------------------------

const toNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Streamed text must keep its whitespace: a delta of `" world"` glued to
 * `"Hello"` without the space corrupts the prose, so the shared trimming
 * reader is wrong here.
 */
const readVerbatimString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.length > 0 ? value : undefined
);

const toTimestamp = (event: OpenCodeEventEnvelope): string => {
  const created = typeof event.created === 'number' && Number.isFinite(event.created) ? event.created : Date.now();
  return new Date(created).toISOString();
};

/** Joins the `content` blocks of a tool result (`[{type:'text', text}]`) into one string. */
const formatToolOutput = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? '' : JSON.stringify(content);
  }
  return content
    .map((block) => {
      const record = readObjectRecord(block);
      if (!record) {
        return typeof block === 'string' ? block : '';
      }
      return readVerbatimString(record.text) ?? (record.type === 'text' ? '' : JSON.stringify(record));
    })
    .filter((text) => text.length > 0)
    .join('\n');
};

const readErrorMessage = (error: unknown): string => {
  const record = readObjectRecord(error);
  return readOptionalString(record?.message)
    ?? readOptionalString(error)
    ?? readOptionalString(record?.type)
    ?? 'Unknown OpenCode error';
};

/**
 * Per-session translator. One instance lives for the life of a run (or a
 * session's attachment) because tool names and reasoning block ids are
 * remembered across events.
 *
 * Consumers: opencode runtime (owns one per active session), opencode
 * interaction bridge (reads `getToolCall`).
 */
export class OpenCodeSessionEventTranslator {
  private readonly toolCalls = new Map<string, OpenCodeToolCall>();
  /** Reasoning blocks that already streamed deltas; `reasoning.ended` must not repeat them. */
  private readonly streamedReasoningBlocks = new Set<string>();

  constructor(
    /** The app session id stamped on every frame (the writer owns provider↔app mapping). */
    private readonly sessionId: string,
  ) {}

  getToolCall(callId: string): OpenCodeToolCall | null {
    return this.toolCalls.get(callId) ?? null;
  }

  translate(event: OpenCodeEventEnvelope): OpenCodeTranslatedEvent {
    const data = readObjectRecord(event.data) ?? {};
    const timestamp = toTimestamp(event);
    const messageId = readOptionalString(data.assistantMessageID) ?? 'message';
    const ordinal = toNumber(data.ordinal);

    switch (event.type) {
      case 'session.text.delta': {
        const delta = readVerbatimString(data.delta);
        if (!delta) {
          return { frames: [] };
        }
        return {
          frames: [createNormalizedMessage({
            id: `${messageId}_text_${ordinal}`,
            sessionId: this.sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'stream_delta',
            content: delta,
          })],
        };
      }

      case 'session.text.ended':
        return {
          frames: [createNormalizedMessage({
            id: `${messageId}_text_${ordinal}_end`,
            sessionId: this.sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'stream_end',
          })],
        };

      case 'session.reasoning.delta': {
        const delta = readVerbatimString(data.delta);
        if (!delta) {
          return { frames: [] };
        }
        const blockId = `${messageId}_reasoning_${ordinal}`;
        this.streamedReasoningBlocks.add(blockId);
        return { frames: [this.thinkingFrame(blockId, delta, timestamp)] };
      }

      case 'session.reasoning.ended': {
        // Providers that never stream reasoning deliver the whole block here.
        const blockId = `${messageId}_reasoning_${ordinal}`;
        if (this.streamedReasoningBlocks.has(blockId)) {
          return { frames: [] };
        }
        const text = readVerbatimString(data.text);
        if (!text?.trim()) {
          return { frames: [] };
        }
        return { frames: [this.thinkingFrame(blockId, text, timestamp)] };
      }

      case 'session.tool.input.started': {
        const callId = readOptionalString(data.id);
        const name = readOptionalString(data.name) ?? 'Tool';
        if (!callId) {
          return { frames: [] };
        }
        this.toolCalls.set(callId, { name, input: {} });
        return { frames: [this.toolUseFrame(callId, name, {}, timestamp)] };
      }

      case 'session.tool.input.ended': {
        const callId = readOptionalString(data.id);
        if (!callId) {
          return { frames: [] };
        }
        const parsedInput = parseToolInputText(data.text);
        if (parsedInput === undefined) {
          return { frames: [] };
        }
        const known = this.toolCalls.get(callId);
        const name = known?.name ?? 'Tool';
        this.toolCalls.set(callId, { name, input: parsedInput });
        return { frames: [this.toolUseFrame(callId, name, parsedInput, timestamp)] };
      }

      case 'session.tool.called': {
        const callId = readOptionalString(data.id);
        if (!callId) {
          return { frames: [] };
        }
        const known = this.toolCalls.get(callId);
        const name = known?.name ?? readOptionalString(data.name) ?? 'Tool';
        const input = data.input ?? known?.input ?? {};
        this.toolCalls.set(callId, { name, input });
        return { frames: [this.toolUseFrame(callId, name, input, timestamp)] };
      }

      case 'session.tool.success': {
        const callId = readOptionalString(data.id);
        if (!callId) {
          return { frames: [] };
        }
        return { frames: [this.toolResultFrame(callId, formatToolOutput(data.content), false, timestamp)] };
      }

      case 'session.tool.failed': {
        const callId = readOptionalString(data.id);
        if (!callId) {
          return { frames: [] };
        }
        return { frames: [this.toolResultFrame(callId, readErrorMessage(data.error), true, timestamp)] };
      }

      case 'session.step.ended':
        // Token totals ride on the session snapshot the runtime already
        // fetches for the budget frame; nothing to accumulate here.
        return { frames: [] };

      case 'session.execution.succeeded':
        return { frames: [], terminal: { outcome: 'succeeded' } };

      case 'session.execution.failed':
        // The runtime renders the failure (one place for failures seen live
        // and failures reconciled after a stream drop), so no frame here.
        return { frames: [], terminal: { outcome: 'failed', error: readErrorMessage(data.error) } };

      case 'session.execution.interrupted':
        return {
          frames: [],
          terminal: { outcome: 'interrupted', reason: readOptionalString(data.reason) ?? 'unknown' },
        };

      default:
        // step.started/streamed/failed, text/reasoning.started, usage.updated,
        // inbox.*, model/agent.selected, permissions, instructions.updated and
        // anything newer carry nothing the timeline renders on its own.
        return { frames: [] };
    }
  }

  private thinkingFrame(blockId: string, content: string, timestamp: string): NormalizedMessage {
    return createNormalizedMessage({
      id: blockId,
      sessionId: this.sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'thinking',
      content,
    });
  }

  private toolUseFrame(callId: string, toolName: string, toolInput: unknown, timestamp: string): NormalizedMessage {
    return createNormalizedMessage({
      id: callId,
      sessionId: this.sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName,
      toolInput,
      toolId: callId,
    });
  }

  private toolResultFrame(callId: string, content: string, isError: boolean, timestamp: string): NormalizedMessage {
    return createNormalizedMessage({
      id: `${callId}_result`,
      sessionId: this.sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: callId,
      content,
      isError,
      toolResult: { content, isError },
    });
  }
}

/** `session.tool.input.ended` carries the raw argument JSON as text; unparseable text is skipped. */
function parseToolInputText(text: unknown): unknown {
  const raw = readOptionalString(text);
  if (raw === undefined) {
    return undefined;
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

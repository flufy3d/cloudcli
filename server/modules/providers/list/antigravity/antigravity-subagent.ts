/**
 * Antigravity Subagent Adapter
 *
 * One `invoke_subagent` call can create several agents, each with its own
 * conversation (`conversation_id`) and transcript. The client draws one
 * subagent card per `Agent` row and a card holds one agent, so a call that
 * created N agents becomes N rows, each named `<call id>:<conversation id>`.
 *
 * Live, the engine names the agents on a dedicated `subagent` step once the
 * call is DONE. In history, the call sits on a planner entry (with the agents'
 * roles and prompts), and the conversation ids appear in the receipt text of
 * the following step. Both paths build rows and ids here, so a refresh redraws
 * exactly the cards the stream drew.
 *
 * @module antigravity-subagent
 */

import fs from 'node:fs';

import type { AnyRecord, NormalizedMessage, SubagentInfo } from '@/shared/types.js';
import {
  SUBAGENT_TOOL_NAME,
  createNormalizedMessage,
  parseProviderJson,
  readObjectRecord,
  readOptionalString,
  sanitizeLeafDirectoryName,
} from '@/shared/utils.js';

import { BackgroundWorkRegistry } from '../../shared/background-work/background-work-registry.js';

import { getAntigravityTranscriptCandidates } from './antigravity-data-root.js';

const PROVIDER = 'antigravity';

/** The engine tool that creates agents. */
export const ANTIGRAVITY_SPAWN_TOOL = 'invoke_subagent';

/**
 * Agents the session still waits on, keyed by app session id and conversation
 * id. The runtime fills it from the live `subagent` step and empties it when
 * the turn result arrives or the process ends; the history reader consults it
 * to tell an agent whose process is alive from one that was cut off.
 *
 * Process-wide by design: the agents are children of this server's `agy`
 * process, so an agent nobody here tracks cannot be running.
 */
export const antigravityBackgroundWork = new BackgroundWorkRegistry();

let unindexedToolCounter = 0;

/**
 * The id both transports must give one tool call.
 *
 * Live reports a tool at its own step index; the transcript declares it on the
 * planner entry one step earlier, with its position in that entry's
 * `tool_calls`. `declaringStepIndex` is that planner step and is offset here,
 * while the live side passes the execution step it already has. An index the
 * engine did not supply falls back to a per-process value, which cannot pair —
 * that is the honest outcome, better than two rows sharing a made-up id.
 *
 * Consumers: the sessions provider (tool rows) and this module (agent rows).
 */
export function buildAntigravityToolId(stepIndex: number | undefined, positionInEntry: number | null): string {
  if (stepIndex === undefined) {
    // A counter, not the clock: two calls read in the same millisecond must
    // not share an id.
    unindexedToolCounter += 1;
    return `tool_unindexed_${unindexedToolCounter}_${Date.now()}`;
  }
  return positionInEntry === null
    ? `tool_${stepIndex}`
    : `tool_${stepIndex + 1 + positionInEntry}`;
}

/**
 * The row id both transports must produce for one tool call.
 *
 * Antigravity reports a call twice — live at its own step, and in history on
 * the planner entry one step earlier — so the step number alone names two
 * different rows. `buildAntigravityToolId` already reconciles that into one
 * call identity; deriving the row id from it is what lets the client see the
 * live card and the persisted card as the same row instead of rendering both.
 *
 * Consumers: the sessions provider (tool rows) and this module (agent rows).
 */
export function buildAntigravityToolRowId(sessionId: string | null, toolId: string): string {
  return `msg_${sessionId ?? ''}_${toolId}`;
}

/** The call id of one agent a call created: the call id plus the agent's conversation id. */
export function buildAntigravityAgentToolId(callToolId: string, conversationId: string): string {
  return `${callToolId}:${conversationId}`;
}

/** What the card needs to know about one agent a call created. */
export type AntigravityAgentSpec = {
  role?: string;
  prompt?: string;
};

const MAX_CARD_DESCRIPTION_LENGTH = 100;

/**
 * The card input for one agent: its role is the card's type, and the first line
 * of its prompt is the one-line description (the role again would print "Role /
 * Role" in the header). An agent with no prompt falls back to its role.
 */
export function toAgentCardInput(spec: AntigravityAgentSpec): AnyRecord {
  const role = spec.role ?? 'Subagent';
  const firstLine = (spec.prompt ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const description = firstLine.length > MAX_CARD_DESCRIPTION_LENGTH
    ? `${firstLine.slice(0, MAX_CARD_DESCRIPTION_LENGTH - 1)}…`
    : firstLine;
  return { subagent_type: role, description: description || role, prompt: spec.prompt ?? '' };
}

/** One `Agent` row for an agent a call created. */
export function createAntigravityAgentRow(input: {
  sessionId: string | null;
  toolId: string;
  spec: AntigravityAgentSpec;
  timestamp?: string;
  sequence?: number;
}): NormalizedMessage {
  return createNormalizedMessage({
    id: buildAntigravityToolRowId(input.sessionId, input.toolId),
    kind: 'tool_use',
    toolName: SUBAGENT_TOOL_NAME,
    toolInput: toAgentCardInput(input.spec),
    toolId: input.toolId,
    sessionId: input.sessionId,
    provider: PROVIDER,
    timestamp: input.timestamp,
    sequence: input.sequence,
  });
}

/** One agent the live `subagent` step names, with the identity its card and task go by. */
export type AntigravityLiveSubagent = AntigravityAgentSpec & {
  conversationId: string;
  /** The id of the agent's `Agent` row; `task_status` events are keyed by it. */
  toolUseId: string;
};

/**
 * The agents a live `subagent` step created.
 *
 * Only the step's DONE update carries each agent's `conversation_id`; an
 * ACTIVE update (or one with no ids) names nobody. A backgrounded
 * run_command needs no card: its `tool` step stays ACTIVE until the command
 * exits and renders as a running tool row.
 *
 * Consumers: the sessions provider (rows) and the runtime (tracking).
 */
export function extractAntigravitySubagents(step: AnyRecord): AntigravityLiveSubagent[] {
  if (readOptionalString(step?.step_type) !== 'subagent' || readOptionalString(step.state) !== 'DONE') {
    return [];
  }
  const subagents = readObjectRecord(step.subagent_info)?.subagents;
  if (!Array.isArray(subagents)) {
    return [];
  }
  const stepIndex = typeof step.step_index === 'number' ? step.step_index : undefined;
  const callToolId = buildAntigravityToolId(stepIndex, null);
  return subagents.flatMap((entry) => {
    const subagent = readObjectRecord(entry);
    const conversationId = readOptionalString(subagent?.conversation_id);
    if (!conversationId) {
      return [];
    }
    return [{
      conversationId,
      toolUseId: buildAntigravityAgentToolId(callToolId, conversationId),
      role: readOptionalString(subagent?.role),
      prompt: readOptionalString(subagent?.initial_prompt),
    }];
  });
}

/**
 * The agent specs a persisted `invoke_subagent` call declares, in the order
 * the engine created them.
 */
export function readInvokedAgentSpecs(args: unknown): AntigravityAgentSpec[] {
  const subagents = readObjectRecord(args)?.Subagents;
  if (!Array.isArray(subagents)) {
    return [];
  }
  return subagents.map((entry) => {
    const spec = readObjectRecord(entry);
    return { role: readOptionalString(spec?.Role), prompt: readOptionalString(spec?.Prompt) };
  });
}

/** The text a finished `invoke_subagent` call's receipt starts its agent list with. */
export const SPAWN_RECEIPT_MARKER = 'Created the following subagents';

/**
 * The conversation ids the live run tracks for one call, in creation order,
 * for a history read taken before the call's receipt was written. `sessionKeys`
 * are the ids the runtime may have registered the session under.
 */
export function readTrackedAgentIds(callToolId: string, sessionKeys: string[]): string[] {
  const prefix = `${callToolId}:`;
  return antigravityBackgroundWork.list()
    .filter((entry) => sessionKeys.includes(entry.sessionId))
    .flatMap((entry) => entry.tasks)
    .filter((task) => task.toolUseId.startsWith(prefix))
    .map((task) => task.taskId);
}

const CONVERSATION_ID_PATTERN = /"conversationId"\s*:\s*"([^"]+)"/g;

/**
 * The conversation ids in the receipt text a finished `invoke_subagent` call
 * leaves ("Created the following subagents: {...} {...}"), in creation order.
 */
export function parseCreatedSubagentIds(receipt: string): string[] {
  return Array.from(receipt.matchAll(CONVERSATION_ID_PATTERN), (match) => match[1]);
}

const AGENT_REPORT_PATTERN = /sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+priority=\S+\s+content=([\s\S]*?)(?:\n<\/SYSTEM_MESSAGE>|$)/gi;

/**
 * The reports agents sent their parent, by the sending agent's conversation
 * id. An agent's report is its answer, and its arrival is the engine's only
 * record that the agent finished.
 */
export function readAgentReports(contents: Iterable<string>): Map<string, string> {
  const reports = new Map<string, string>();
  for (const content of contents) {
    for (const match of content.matchAll(AGENT_REPORT_PATTERN)) {
      reports.set(match[1].toLowerCase(), match[2].trim());
    }
  }
  return reports;
}

/** Rows of a transcript that are bookkeeping, never the agent's own last word. */
const NON_OUTCOME_ROW_TYPES = new Set(['CHECKPOINT', 'SYSTEM_MESSAGE', 'EPHEMERAL_MESSAGE', 'CONVERSATION_HISTORY']);

/** How much of a transcript's tail is read to judge how it ended. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * How an agent ended, from the last meaningful row of its own transcript:
 * an engine error is `failed`; a planner reply that asks for no further tool
 * is `completed`; anything else (a tool still running or just returned, no
 * transcript at all) leaves the agent unfinished, which reads `stopped`.
 */
export function judgeAgentTranscriptRows(rows: AnyRecord[]): SubagentInfo['status'] {
  const ordered = rows
    .map((row, position) => ({ row, position }))
    .sort((a, b) => {
      const left = typeof a.row.step_index === 'number' ? a.row.step_index : Number.MAX_SAFE_INTEGER;
      const right = typeof b.row.step_index === 'number' ? b.row.step_index : Number.MAX_SAFE_INTEGER;
      return left - right || a.position - b.position;
    })
    .map((entry) => entry.row);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const row = ordered[index];
    const type = readOptionalString(row.type);
    if (type && NON_OUTCOME_ROW_TYPES.has(type)) {
      continue;
    }
    if (type === 'ERROR_MESSAGE') {
      return 'failed';
    }
    const asksForTool = Array.isArray(row.tool_calls) && row.tool_calls.length > 0;
    return type === 'PLANNER_RESPONSE' && readOptionalString(row.status) === 'DONE' && !asksForTool
      ? 'completed'
      : 'stopped';
  }
  return 'stopped';
}

/**
 * The one judgement of how an agent ended, shared by the live settle at the
 * turn result and the history reader, so a card reads the same either way.
 * Reads the tail of the agent's own transcript in the brain directory by its
 * conversation id (synchronously: the live settle runs inside the stdout
 * handler and must finish before the turn's `complete`).
 *
 * `report` is the answer the agent sent its parent, when the parent's
 * transcript holds one; it is proof of completion on its own.
 */
export function judgeAntigravityAgent(conversationId: string, report?: string): SubagentInfo['status'] {
  if (report !== undefined) {
    return 'completed';
  }
  let safeId: string;
  try {
    safeId = sanitizeLeafDirectoryName(conversationId, 'antigravity session id');
  } catch {
    return 'stopped';
  }
  const transcriptPath = getAntigravityTranscriptCandidates(safeId).find((candidate) => fs.existsSync(candidate));
  if (!transcriptPath) {
    return 'stopped';
  }
  let text: string;
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const descriptor = fs.openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(descriptor);
    }
    if (start > 0) {
      // The cut can land mid-line; the first fragment is not a row.
      text = text.slice(text.indexOf('\n') + 1);
    }
  } catch (error) {
    console.error(`[AntigravitySubagent] Could not read the transcript of agent ${conversationId}:`, error);
    return 'stopped';
  }
  const rows: AnyRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = readObjectRecord(parseProviderJson(line));
      if (row) rows.push(row);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return judgeAgentTranscriptRows(rows);
}

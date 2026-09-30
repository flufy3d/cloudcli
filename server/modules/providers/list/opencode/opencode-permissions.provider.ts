import type {
  AnyRecord,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import type { OpenCodeServerEvent, OpenCodeServerHandle } from './opencode-server.client.js';
import {
  readOpenCodeSessionParentId,
  rejectOpenCodeQuestion,
  replyOpenCodePermission,
  replyOpenCodeQuestion,
  shouldAutoApproveOpenCodePermission,
} from './opencode-server.client.js';

/**
 * Interactive approval bridge for OpenCode.
 *
 * The OpenCode server announces tool approvals on `permission.asked` and the
 * AskUserQuestion tool on `question.asked`; both stay pending until a client
 * answers them over HTTP. This module turns those announcements into the chat's
 * `permission_request` cards (the same shape Claude and ZCode use), remembers
 * what each `requestId` belongs to, and translates the user's decision back
 * into the engine's reply.
 *
 * It is the runtime's optional `permissions` facet, so its presence is what
 * flips `supportsPermissionRequests` on for OpenCode. The chat gateway fans a
 * decision out to every provider's facet (`resolveToolApproval`); this bridge
 * only acts on request ids it announced itself.
 */

/** Immutable facts about one active run the bridge needs to answer its requests. */
export type OpenCodeBridgeRun = {
  runId: string;
  appSessionId: string | null;
  providerSessionId: string;
  directory: string;
  handle: OpenCodeServerHandle;
  writer: ProviderRuntimeWriter;
  permissionMode: string | undefined;
};

type OpenCodePendingEntry = {
  requestId: string;
  kind: 'permission' | 'question';
  run: OpenCodeBridgeRun;
  toolName: string;
  toolId: string | null;
  input: unknown;
  context: unknown;
  questions: OpenCodeQuestionInfo[];
  receivedAt: Date;
};

/** One AskUserQuestion entry in the frontend's `Question` shape. */
type OpenCodeQuestionInfo = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

const runs = new Map<string, OpenCodeBridgeRun>();
const pending = new Map<string, OpenCodePendingEntry>();

/**
 * Ownership verdicts for approval events announced by sessions other than the
 * run's own — subagent (task child) sessions. Keyed by run id, then by the
 * announcing session id; values are promises so simultaneous events from the
 * same session share one parent-chain lookup. Cleared with the run.
 */
const foreignSessionVerdicts = new Map<string, Map<string, Promise<boolean>>>();

function readToolCallId(event: OpenCodeServerEvent): string | null {
  return readOptionalString(readObjectRecord(event.properties.tool)?.callID) ?? null;
}

/** Maps the engine's question payload onto the chat's `Question` shape. */
function readQuestionInfos(event: OpenCodeServerEvent): OpenCodeQuestionInfo[] {
  const raw = event.properties.questions;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((entry) => {
    const record = readObjectRecord(entry) ?? {};
    const options = Array.isArray(record.options)
      ? record.options.map((option) => {
          const optionRecord = readObjectRecord(option) ?? {};
          return {
            label: readOptionalString(optionRecord.label) ?? '',
            description: readOptionalString(optionRecord.description) ?? undefined,
          };
        }).filter((option) => option.label.length > 0)
      : [];

    return {
      question: readOptionalString(record.question) ?? '',
      header: readOptionalString(record.header) ?? undefined,
      options,
      multiSelect: record.multiple === true,
    };
  }).filter((question) => question.question.length > 0);
}

/** Registers one run so its announcements can be answered. */
export function registerOpenCodeRun(run: OpenCodeBridgeRun): void {
  runs.set(run.runId, run);
}

/**
 * Drops a finished run and retracts any cards it left pending, so a client
 * that reconnects after the run died never sees zombie approvals.
 */
export function unregisterOpenCodeRun(runId: string): void {
  runs.delete(runId);
  foreignSessionVerdicts.delete(runId);

  for (const [requestId, entry] of pending) {
    if (entry.run.runId !== runId) {
      continue;
    }
    retractPending(requestId, entry);
    pending.delete(requestId);
  }
}

function retractPending(requestId: string, entry: OpenCodePendingEntry): void {
  try {
    entry.run.writer.send(createNormalizedMessage({
      id: generateMessageId('opencode'),
      sessionId: entry.run.appSessionId ?? entry.run.providerSessionId,
      provider: 'opencode',
      kind: 'permission_cancelled',
      requestId,
    }));
  } catch {
    // The run's transport may already be gone; there is nobody to retract to.
  }
}

/**
 * Event types the bridge owns. The runtime must route them here before its own
 * switch: doing so is what lets subagent approvals be re-attributed to the run
 * instead of being dropped with the rest of the child stream.
 */
const APPROVAL_EVENT_TYPES = new Set([
  'permission.asked',
  'permission.replied',
  'question.asked',
  'question.replied',
  'question.rejected',
]);

/**
 * Whether the runtime must route this event through the approval bridge
 * instead of its own stream switch. Consumers: `opencode-runtime.provider.js`.
 */
export function isOpenCodeApprovalEvent(type: string): boolean {
  return APPROVAL_EVENT_TYPES.has(type);
}

/** Fans one owned approval event to the card flow it belongs to. */
function dispatchApprovalEvent(run: OpenCodeBridgeRun, event: OpenCodeServerEvent): void {
  switch (event.type) {
    case 'permission.asked':
      announceOpenCodePermission(run, event);
      return;
    case 'question.asked':
      announceOpenCodeQuestion(run, event);
      return;
    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected':
      settleOpenCodeEvent(event);
      return;
    default:
      return;
  }
}

/**
 * Routes one approval event for a run. Events from the run's own session are
 * dispatched synchronously; events from other sessions are bridged only after
 * their `parentID` chain proves they came from a subagent of this run. Child
 * sessions run their own approval flow, and their cards must render on the
 * parent chat — the runtime never sees their events otherwise. Unrelated
 * sessions on the shared server are ignored. Consumers:
 * `opencode-runtime.provider.js`.
 */
export function handleOpenCodeApprovalEvent(run: OpenCodeBridgeRun, event: OpenCodeServerEvent): void {
  const eventSessionId = readOptionalString(event.properties.sessionID);
  if (!eventSessionId || !run.providerSessionId) {
    return;
  }

  if (eventSessionId === run.providerSessionId) {
    dispatchApprovalEvent(run, event);
    return;
  }

  void isForeignSessionOwned(run, eventSessionId).then((owned) => {
    if (owned) {
      dispatchApprovalEvent(run, event);
    }
  }).catch(() => {
    // A failed ownership lookup drops the event, exactly as the session filter
    // did before subagent routing existed; the run's own stream is unaffected.
  });
}

/**
 * Walks a session's `parentID` chain up to the run's own session. Each step is
 * one cheap GET; `seen` guards against a malformed chain.
 */
async function sessionBelongsToRun(run: OpenCodeBridgeRun, sessionId: string): Promise<boolean> {
  let current: string | null = sessionId;
  const seen = new Set<string>();

  while (current && !seen.has(current)) {
    if (current === run.providerSessionId) {
      return true;
    }
    seen.add(current);
    current = await readOpenCodeSessionParentId(run.handle, run.directory, current);
  }
  return false;
}

/** Caches one ownership verdict per (run, session); failed lookups retry. */
function isForeignSessionOwned(run: OpenCodeBridgeRun, sessionId: string): Promise<boolean> {
  const verdicts = foreignSessionVerdicts.get(run.runId) ?? new Map<string, Promise<boolean>>();
  foreignSessionVerdicts.set(run.runId, verdicts);

  const cached = verdicts.get(sessionId);
  if (cached) {
    return cached;
  }

  const verdict = sessionBelongsToRun(run, sessionId);
  verdict.catch(() => verdicts.delete(sessionId));
  verdicts.set(sessionId, verdict);
  return verdict;
}

/**
 * Bridges one `permission.asked` event. In `bypassPermissions` the request is
 * answered `once` silently (the server-side equivalent of `opencode run
 * --auto`); every other mode renders an approval card.
 */
export function announceOpenCodePermission(run: OpenCodeBridgeRun, event: OpenCodeServerEvent): void {
  const requestId = readOptionalString(event.properties.id);
  if (!requestId) {
    return;
  }

  const permission = readOptionalString(event.properties.permission) ?? 'permission';

  if (shouldAutoApproveOpenCodePermission(run.permissionMode, permission)) {
    void replyOpenCodePermission(run.handle, run.directory, requestId, 'once');
    return;
  }

  const patterns = Array.isArray(event.properties.patterns)
    ? event.properties.patterns.filter((value): value is string => typeof value === 'string')
    : [];
  const metadata = readObjectRecord(event.properties.metadata) ?? {};

  pending.set(requestId, {
    requestId,
    kind: 'permission',
    run,
    toolName: permission,
    toolId: readToolCallId(event),
    input: { permission, patterns, metadata },
    context: patterns.length > 0 ? { reason: patterns.join(', ') } : undefined,
    questions: [],
    receivedAt: new Date(),
  });

  run.writer.send(createNormalizedMessage({
    id: generateMessageId('opencode'),
    sessionId: run.appSessionId ?? run.providerSessionId,
    provider: 'opencode',
    kind: 'permission_request',
    requestId,
    toolName: permission,
    toolId: readToolCallId(event) ?? undefined,
    input: { permission, patterns, metadata },
    context: patterns.length > 0 ? { reason: patterns.join(', ') } : undefined,
    canInterrupt: true,
  }));
}

/**
 * Bridges one `question.asked` event onto the same pending-card flow as tool
 * approvals; the AskUserQuestion panel renders by tool name and collects
 * `answers`.
 */
export function announceOpenCodeQuestion(run: OpenCodeBridgeRun, event: OpenCodeServerEvent): void {
  const requestId = readOptionalString(event.properties.id);
  if (!requestId) {
    return;
  }

  const questions = readQuestionInfos(event);
  if (questions.length === 0) {
    void rejectOpenCodeQuestion(run.handle, run.directory, requestId);
    return;
  }

  const input = { questions };

  pending.set(requestId, {
    requestId,
    kind: 'question',
    run,
    toolName: 'AskUserQuestion',
    toolId: readToolCallId(event),
    input,
    context: undefined,
    questions,
    receivedAt: new Date(),
  });

  run.writer.send(createNormalizedMessage({
    id: generateMessageId('opencode'),
    sessionId: run.appSessionId ?? run.providerSessionId,
    provider: 'opencode',
    kind: 'permission_request',
    requestId,
    toolName: 'AskUserQuestion',
    toolId: readToolCallId(event) ?? undefined,
    input,
    canInterrupt: true,
  }));
}

/** Retracts a question card once the engine confirms the answer. */
export function settleOpenCodeEvent(event: OpenCodeServerEvent): void {
  const requestId = readOptionalString(event.properties.requestID) ?? readOptionalString(event.properties.id);
  if (!requestId) {
    return;
  }
  const entry = pending.get(requestId);
  if (!entry) {
    return;
  }
  pending.delete(requestId);
  retractPending(requestId, entry);
}

/**
 * Builds the engine's ordered answer arrays from the panel's answer map. The
 * panel keys answers by question text and joins multi-select labels with `, `.
 */
function buildQuestionAnswers(entry: OpenCodePendingEntry, decision: ProviderPermissionDecision): string[][] {
  const answered = readObjectRecord(readObjectRecord(decision.updatedInput)?.answers) ?? {};
  return entry.questions.map((question) => {
    const value = answered[question.question];
    if (typeof value !== 'string' || !value.trim()) {
      return [];
    }
    return value.split(', ').map((label) => label.trim()).filter((label) => label.length > 0);
  });
}

function resolvePermissionEntry(entry: OpenCodePendingEntry, decision: ProviderPermissionDecision): void {
  const { run, requestId } = entry;

  if (!decision.allow) {
    void replyOpenCodePermission(run.handle, run.directory, requestId, 'reject', decision.message ?? 'Denied by user');
    return;
  }

  // `always` lets the engine persist the patterns it proposed for this project;
  // the chat's "Allow & remember" action is what sets `rememberEntry`.
  const reply = decision.rememberEntry ? 'always' : 'once';
  void replyOpenCodePermission(run.handle, run.directory, requestId, reply);
}

function resolveQuestionEntry(entry: OpenCodePendingEntry, decision: ProviderPermissionDecision): void {
  const { run, requestId } = entry;

  if (!decision.allow) {
    void rejectOpenCodeQuestion(run.handle, run.directory, requestId);
    return;
  }

  if (!decision.updatedInput) {
    // "Skip" answers nothing; the engine treats an empty answer set as skipped.
    void replyOpenCodeQuestion(run.handle, run.directory, requestId, entry.questions.map(() => []));
    return;
  }

  void replyOpenCodeQuestion(run.handle, run.directory, requestId, buildQuestionAnswers(entry, decision));
}

/**
 * The runtime's `permissions` facet. The chat gateway fans every decision out
 * to all providers; this facet ignores ids it did not announce.
 */
export const openCodePermissions = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    const entry = pending.get(requestId);
    if (!entry) {
      return;
    }

    pending.delete(requestId);
    if (entry.kind === 'question') {
      resolveQuestionEntry(entry, decision);
    } else {
      resolvePermissionEntry(entry, decision);
    }
    retractPending(requestId, entry);
  },

  listPending(sessionId: string): AnyRecord[] {
    const views: AnyRecord[] = [];
    for (const entry of pending.values()) {
      if (entry.run.appSessionId !== sessionId && entry.run.providerSessionId !== sessionId) {
        continue;
      }
      views.push({
        requestId: entry.requestId,
        toolName: entry.toolName,
        toolId: entry.toolId ?? undefined,
        input: entry.input,
        context: entry.context,
        sessionId: entry.run.appSessionId ?? entry.run.providerSessionId,
        receivedAt: entry.receivedAt,
      });
    }
    return views;
  },
};

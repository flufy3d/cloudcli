/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { createBackgroundWorkTracker } from '@/modules/providers/list/claude/claude-background-work.js';
import { createSubagentOriginTracker } from '@/modules/providers/list/claude/claude-subagent-origin.js';
import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import { canonicalClaudeSubagentToolName, createCompleteMessage, createNormalizedMessage, resolveModelEffort } from '@/shared/utils.js';

export { createBackgroundWorkTracker, extractBackgroundTasks, startsBackgroundWork } from '@/modules/providers/list/claude/claude-background-work.js';

const activeSessions = new Map();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the map entry it shadows: cleared when the
// session is removed, and reset when a newer run takes the key over.
const backgroundWork = createBackgroundWorkTracker();
/** How long an approval request waits for the stream to show its tool call before going without an origin. */
const SUBAGENT_ORIGIN_WAIT_MS = 1500;

const pendingToolApprovals = new Map();
// Query instances cancelled via abort-session. The abort handler sends the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedInstances = new WeakSet();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();
// Query instances whose reply the user stopped while background work it
// launched was still running. Like Esc in the CLI, only the turn is
// interrupted: the process stays up for that work, and the interrupted
// turn's `result` hands the run over to the usual post-turn hold.
// Keyed by query instance; the value tells one stop's fallback timer from a
// later stop's on the same process.
const turnOnlyAbortTokens = new WeakMap();
// How long a turn-only stop waits for the interrupted turn's `result` before
// giving up on the process. The CLI answers interrupt() at once; this only
// catches one that never does, so it cannot sit on stdin for ever.
const TURN_ONLY_ABORT_RESULT_WAIT_MS = 30_000;
// How long a held process gets to switch model, permission mode or effort
// before the turn moves to a fresh process instead.
const HELD_PROCESS_SWITCH_TIMEOUT_MS = 10_000;

// Tools plan mode allows without asking. `Agent` is the CLI's current subagent
// tool; `Task` is its legacy name, which the CLI still resolves to `Agent` in
// permission rules (its legacy tool-name map), kept so rules written for older
// CLIs keep matching.
const PLAN_MODE_TOOLS = ['Read', 'Agent', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, and background work releases it as soon as it reports back;
// a new turn either continues on the held process or supersedes it. This ceiling
// only catches background work that never reports at all, so an abandoned session
// cannot leak a CLI process forever. The timer resets on every message, so it
// measures silence, not total time — and a dev server left running in the
// background prints nothing back for long stretches, hence two hours.
const BG_WAIT_CEILING_MS = 2 * 60 * 60 * 1000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions, resolvedEffort) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

const CLAUDE_CLI_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The catalog entry whose effort tiers a model is checked against: the exact id, or the base
 * entry for a 1M alias an older session saved (`opus[1m]` -> `opus`), since the CLI's base
 * aliases now run at 1M context themselves.
 */
function findEffortCatalogOption(model, catalog) {
  const options = catalog?.OPTIONS || [];
  const exact = options.find((option) => option.value === model);
  if (exact || typeof model !== 'string' || !model.endsWith('[1m]')) return exact || null;
  return options.find((option) => option.value === model.slice(0, -'[1m]'.length)) || null;
}

/**
 * Validates the effort against the model's catalog entry. A model with no entry (an older
 * session's `opusplan`, a custom id) has no tiers to check, so a plain CLI level passes
 * through: measured on 2.1.303, `--effort high` with a model that has no tiers runs normally.
 */
export function resolveClaudeEffort(model, effort, catalog) {
  const option = findEffortCatalogOption(model, catalog);
  if (option) {
    return resolveModelEffort(option.value, effort, catalog);
  }
  return CLAUDE_CLI_EFFORT_LEVELS.has(effort) ? effort : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Lets the run that raised this request take it down when its process ends.
    resolver._cancel = (reason) => {
      onCancel?.(reason);
      finalize({ cancelled: true });
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

/**
 * Retracts every request a finished run left unanswered. An interactive tool
 * (a question, a plan) waits without a timeout, and a subagent's request
 * outlives the turn that spawned it; when the process exits nobody can answer,
 * and the page would keep the card for ever.
 */
function cancelRunApprovals(runToken) {
  for (const resolver of [...pendingToolApprovals.values()]) {
    if (resolver._runToken === runToken) {
      resolver._cancel?.('cancelled');
    }
  }
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
/** Used by the tool-permission tests; the matcher itself only serves `canUseTool` below. */
export function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  // A rule saved as `Task` (the subagent tool's old name) must keep matching
  // the `Agent` the CLI asks about now, and the reverse.
  if (entry === toolName || canonicalClaudeSubagentToolName(entry) === canonicalClaudeSubagentToolName(toolName)) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS) };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Pinned explicitly: since SDK 0.3.286 an omitted permissionMode defers to the
  // CLI settings' defaultMode, which can start sessions in an auto-approving mode.
  sdkOptions.permissionMode = permissionMode && permissionMode !== 'default' ? permissionMode : 'default';

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    for (const tool of PLAN_MODE_TOOLS) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 * @param {{ isTurnInFlight?: Function, continueTurn?: Function, withdrawPendingTurn?: Function }} turnHooks -
 *   Whether the current turn's reply is still running, how a later turn hands itself to this
 *   process, and how a stop withdraws a handed-over turn not yet written into it
 */
function addSession(sessionId, queryInstance, writer = null, releaseInput = null, turnHooks = {}) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Interrupt the captured old instance directly; its release must never
  // look up the new instance under this session id.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding) {
    supersededInstances.add(existing.instance);
    Promise.resolve()
      .then(() => existing.instance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    existing.releaseInput?.();
    // Whatever the superseded process had outstanding dies with it and will
    // never report, so the new run starts from an empty task set.
    backgroundWork.clear(sessionId);
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null,
    isTurnInFlight: turnHooks.isTurnInFlight || carried?.isTurnInFlight || null,
    continueTurn: turnHooks.continueTurn || carried?.continueTurn || null,
    withdrawPendingTurn: turnHooks.withdrawPendingTurn || carried?.withdrawPendingTurn || null
  });
  // The history reader reports a background agent as running or stopped by
  // whether this entry exists, and the cached history does not see this map.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
  // No process, no background work: anything still tracked was killed with it.
  backgroundWork.clear(sessionId);
  // See addSession: a page cached while the process was up still says
  // `running` for any agent that never reported back.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// The whole-assistant-output regex a turn must match to count as a
// notification-only acknowledgement. The engine tells the model to answer
// injected task-notifications with this placeholder when no action is needed.
const NO_RESPONSE_PLACEHOLDER_RE = /^no response requested\.?$/i;

/**
 * True when an SDK user message is an engine-injected task notification.
 *
 * On resume, the CLI reconciles the transcript and injects a user frame whose
 * text starts with `<task-notification>` for background tasks that ended
 * without a completion record (killed at teardown, orphaned across CLI
 * processes). Detecting it at the runtime layer (instead of relying on the
 * sessions normalizer) keeps the swallowed-prompt detection self-contained.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean}
 */
export function isTaskNotificationUserMessage(sdkMessage) {
  if (!sdkMessage || sdkMessage.type !== 'user') {
    return false;
  }
  const content = sdkMessage.message?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((block) => block?.type === 'text')
      .map((block) => block.text || '')
      .join('\n');
  }
  return text.trimStart().startsWith('<task-notification>');
}

/**
 * True when a turn's whole assistant output is the notification placeholder.
 * Markdown emphasis wrappers are stripped so `*No response requested.*`
 * still matches.
 * @param {string} text - Concatenated assistant text of the turn
 * @returns {boolean}
 */
function isNoResponsePlaceholder(text) {
  const stripped = String(text || '').trim().replace(/^[\s*_`]+|[\s*_`]+$/g, '');
  return NO_RESPONSE_PLACEHOLDER_RE.test(stripped);
}

/**
 * True when a turn swallowed the user's prompt and must be re-sent.
 *
 * When the CLI injects a task-notification into the same turn as the user's
 * prompt, the model can answer only the notification ("No response
 * requested.") and end the turn, leaving the prompt unacted upon. All four
 * conditions together are required: with no notification present, a short
 * placeholder-like reply is a legitimate answer to a prompt like "don't
 * reply"; with any tool call, the turn did act on something.
 *
 * Consumed by queryClaudeSDK to trigger its one-shot idle-turn resend.
 * @param {Object} signals - Turn signals collected across the stream
 * @param {boolean} signals.hasPrompt - The run was started with a non-empty prompt
 * @param {boolean} signals.sawTaskNotification - An injected task-notification was received
 * @param {string} signals.assistantText - All main-thread assistant text of the turn
 * @param {number} signals.toolUseCount - Main-thread tool calls made during the turn
 * @returns {boolean}
 */
export function shouldResendPromptForIdleTurn({ hasPrompt, sawTaskNotification, assistantText, toolUseCount }) {
  return Boolean(
    hasPrompt
    && sawTaskNotification
    && toolUseCount === 0
    && isNoResponsePlaceholder(assistantText)
  );
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * `push` writes a later turn's messages into the same stdin: the CLI takes
 * them as a new turn of the same process, so background work it is running
 * outlives the turn that started it.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void, push: (messages: Array<Object>) => void }} Stream, its closer, and its writer
 */
function createHeldPromptStream(messages) {
  const queue = [...messages];
  let wake = null;
  let released = false;

  const stream = (async function* () {
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift();
      }
      // Keeps stdin open — the CLI stays alive until release() is called.
      if (released) return;
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
  })();

  return {
    stream,
    release: () => { released = true; wake?.(); },
    push: (more) => { queue.push(...more); wake?.(); },
  };
}

/**
 * The SDK options and stdin messages for one turn, as the run would start a
 * process with them. Shared by a fresh run and by the check whether a held
 * process can take the turn instead.
 */
async function prepareTurnInputs(command, options, context, providerSessionId) {
  const resolvedModel = await context.resolveResumeModel(options.sessionId, options.model);
  let effortModels = CLAUDE_PREDEFINED_MODELS;
  try {
    effortModels = await context.getProviderModels();
  } catch (error) {
    console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
  }

  const sdkOptions = mapCliOptionsToSDK({
    ...options,
    providerSessionId,
    model: resolvedModel || options.model,
    effortModels,
  });

  const mcpServers = await loadMcpConfig(options.cwd);
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
  }

  // Every turn uses streaming input so stdin stays open past the turn's
  // `result`. The message list is reusable, but each query attempt needs its
  // own stream because an async generator cannot be replayed once consumed.
  const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);
  const baseAllowedTools = [...(options.toolsSettings?.allowedTools || [])];
  const modelOption = findEffortCatalogOption(sdkOptions.model, effortModels);
  return {
    sdkOptions,
    promptMessages,
    baseAllowedTools,
    compatibilityKey: heldProcessCompatibilityKey(sdkOptions, baseAllowedTools),
    // Whether the model takes an effort at all; the CLI ignores one for a
    // model that does not (measured: no `output_config` after `setModel('haiku')`).
    // A model with no catalog entry is assumed to, as `resolveClaudeEffort` does.
    modelTakesEffort: modelOption ? Boolean(modelOption.effort?.values?.length) : true,
  };
}

/**
 * What a held process must share with a turn to take it: everything fixed at
 * process start. The model, permission mode and effort are left out because a
 * held process switches them (`setModel`, `setPermissionMode`,
 * `applyFlagSettings({ effortLevel })`); the resume id is left out because it
 * is the session the process already runs.
 */
function heldProcessCompatibilityKey(sdkOptions, baseAllowedTools) {
  const {
    model: _model, permissionMode: _permissionMode, effort: _effort, allowedTools: _allowedTools,
    resume: _resume, env: _env, hooks: _hooks, canUseTool: _canUseTool, ...fixedAtStart
  } = sdkOptions;
  // Plan mode's own additions to `allowedTools` follow the permission mode,
  // so only the user's list counts.
  return JSON.stringify({ ...fixedAtStart, allowedTools: baseAllowedTools });
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId } = options;
  // Rebound, with `command`, `options` and `ws`, when a later turn of the
  // session continues on this run's held process (see `continueTurn`).
  let sessionSummary = options.sessionSummary;
  // Identifies this run's pending approvals, so its end can retract them.
  const runToken = Symbol('claude-run');
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  let idleReleaseTimer = null;
  let wakeupCardTimer = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // Idle-turn detection: a resumed turn that only acknowledges an injected
  // task-notification ("No response requested.") leaves the user's prompt
  // unacted upon. Signals are collected across the stream and evaluated once
  // at the turn's `result`; when they all line up, the prompt is re-sent on a
  // fresh CLI process after this generator winds down.
  let turnSawTaskNotification = false;
  let turnAssistantText = '';
  let turnToolUseCount = 0;
  let pendingIdleResend = false;
  // Held-process continuation: whether stdin was closed (the process is on its
  // way out and takes no more turns), whether the CLI is inside a turn of its
  // own (between `init` and `result`), the later turn waiting for that turn to
  // end, and the continued turns' callers waiting for their `result`.
  let inputReleased = false;
  let cliTurnActive = false;
  let pendingTurn = null;
  const turnResolvers = [];
  const resolveTurns = () => {
    for (const resolveTurn of turnResolvers.splice(0)) resolveTurn();
  };

  // A process held open for background work takes the session's next turn
  // on the same stdin, so that work outlives the turn — as in the CLI. The
  // turn then belongs to that process's run, and this call only waits for it.
  const continued = await continueOnHeldProcess(command, options, ws, context, providerSessionId);
  if (continued) {
    return continued.turn;
  }

  // Otherwise a new turn supersedes any earlier one still holding this
  // session's process open, so held runs cannot stack up across a conversation.
  if (sessionKey()) {
    getSession(sessionKey())?.releaseInput?.();
  }

  let lastBroadcastHadTasks = false;
  let backgroundReplyPending = false;
  let lastBroadcastPending = false;
  const broadcastBackgroundTasks = () => {
    if (supersededInstances.has(queryInstance)) return;
    const list = backgroundWork.activeTasks(sessionKey());
    lastBroadcastHadTasks = list.length > 0;
    lastBroadcastPending = backgroundWork.hasPending(sessionKey()) || backgroundReplyPending;
    const session = getSession(sessionKey());
    if (session?.instance === queryInstance) session.backgroundReplyPending = backgroundReplyPending;
    ws?.send?.(createNormalizedMessage({
      kind: 'status',
      text: 'background_tasks',
      backgroundTasks: list,
      backgroundWorkPending: lastBroadcastPending,
      // The next message joins the held process as a turn of its own.
      backgroundWorkQueuesInput: false,
      sessionId: capturedSessionId || sessionId || null,
      provider: 'claude'
    }));
  };

  // A wakeup has no task-completion event. Retire its waiting card at the
  // acknowledged deadline, but leave stdin open for the reply it triggers.
  const scheduleWakeupCardExpiry = () => {
    if (wakeupCardTimer) clearTimeout(wakeupCardTimer);
    wakeupCardTimer = null;
    const deadline = backgroundWork.nextWakeupAt(sessionKey());
    if (deadline === undefined) return;
    wakeupCardTimer = setTimeout(() => {
      wakeupCardTimer = null;
      if (supersededInstances.has(queryInstance)) return;
      if (backgroundWork.expireWakeups(sessionKey())) {
        backgroundReplyPending = true;
        broadcastBackgroundTasks();
      }
      scheduleWakeupCardExpiry();
    }, Math.min(Math.max(0, deadline - Date.now()), 2 ** 31 - 1));
    wakeupCardTimer.unref?.();
  };

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      releasePromptStream();
    }, BG_WAIT_CEILING_MS);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance = null;

  try {
    // The key is fixed before `canUseTool` can widen `allowedTools` for a remembered grant.
    const { sdkOptions, promptMessages, compatibilityKey } = await prepareTurnInputs(command, options, context, providerSessionId);
    // What the process was started with, for the switches a continued turn makes.
    const startedWithEffort = sdkOptions.effort !== undefined;
    const startedInPlan = sdkOptions.permissionMode === 'plan';
    const startedWithBypass = sdkOptions.permissionMode === 'bypassPermissions';
    let currentEffort = sdkOptions.effort;

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    const subagentOrigins = createSubagentOriginTracker();
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      // The callback serves the main thread and every subagent alike; the
      // stream told us which card the asking call was made under.
      // (Observed live: the stream leads by a millisecond or so, but the two
      // travel separately, so a request that wins the race waits briefly.)
      await subagentOrigins.whenObserved(context?.toolUseID, SUBAGENT_ORIGIN_WAIT_MS);
      const subagent = subagentOrigins.originOf(context?.toolUseID);
      const requestContext = subagent ? { subagent } : undefined;
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, context: requestContext, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _context: requestContext,
          _runToken: runToken,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // The SDK's own `query`, unless the caller supplies one (tests script the
    // stream to drive the hold logic below without a CLI process).
    const createQuery = context.createQuery ?? query;
    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = () => { inputReleased = true; heldPrompt.release(); };
    try {
      queryInstance = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      queryInstance = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    }

    const isTurnInFlight = () => !turnCompleteSent;

    // A turn the process cannot take after all goes to a fresh process,
    // which supersedes this one as any new run does.
    const moveTurnToFreshProcess = (next) => {
      next.resolve(queryClaudeSDK(next.command, { ...next.options, skipHeldProcess: true }, next.writer, context));
    };
    // The process can no longer take a turn: it is going away, so the run's
    // wind-down (`finally`) moves whatever is still pending.
    const processGoingAway = () => inputReleased || supersededInstances.has(queryInstance)
      || (abortedInstances.has(queryInstance) && !turnOnlyAbortTokens.has(queryInstance));

    // Applies a continued turn's model, permission mode and effort to the
    // live process. Measured: each takes effect from the next turn's request.
    const switchProcessFor = async (next) => {
      if (next.sdkOptions.model !== sdkOptions.model) {
        await queryInstance.setModel(next.sdkOptions.model);
        sdkOptions.model = next.sdkOptions.model;
      }
      const nextMode = next.sdkOptions.permissionMode ?? 'default';
      if (nextMode !== (sdkOptions.permissionMode ?? 'default')) {
        await queryInstance.setPermissionMode(nextMode);
        sdkOptions.permissionMode = next.sdkOptions.permissionMode;
        // `canUseTool` reads this list; plan mode's tools come and go with it.
        const planTools = new Set(PLAN_MODE_TOOLS.filter((tool) => !next.baseAllowedTools.includes(tool)));
        const kept = sdkOptions.allowedTools.filter((tool) => !planTools.has(tool));
        sdkOptions.allowedTools = nextMode === 'plan' ? [...kept, ...planTools] : kept;
      }
      const nextEffort = next.sdkOptions.effort;
      if (nextEffort !== undefined && nextEffort !== currentEffort) {
        await queryInstance.applyFlagSettings({ effortLevel: nextEffort });
        currentEffort = nextEffort;
      } else if (nextEffort === undefined && next.modelTakesEffort && currentEffort !== undefined) {
        // Back to the CLI's default; reachable only when the process started
        // without `--effort`, which `continueTurn` checks.
        await queryInstance.applyFlagSettings({ effortLevel: null });
        currentEffort = undefined;
      }
    };

    // Starts the turn handed over by `continueTurn`: switches the process to
    // the turn's settings, rebinds the per-turn state to the new turn's
    // writer, and writes its messages into stdin. The turn stays in
    // `pendingTurn` until it is written, so a stop can withdraw it and the
    // run's wind-down can move it while the switches are awaited.
    const startPendingTurn = async () => {
      const next = pendingTurn;
      if (!next || next.starting) return;
      next.starting = true;
      try {
        let switchTimer;
        await Promise.race([
          switchProcessFor(next),
          new Promise((_resolve, reject) => {
            switchTimer = setTimeout(() => reject(new Error('switch timed out')), HELD_PROCESS_SWITCH_TIMEOUT_MS);
            switchTimer.unref?.();
          }),
        ]).finally(() => clearTimeout(switchTimer));
      } catch (error) {
        if (pendingTurn !== next) return;
        pendingTurn = null;
        console.warn('[Claude SDK] Held process could not switch to the next turn\'s settings; starting a fresh one:', error?.message || error);
        moveTurnToFreshProcess(next);
        return;
      }
      // Withdrawn by a stop, or already moved by the wind-down.
      if (pendingTurn !== next || processGoingAway()) return;
      pendingTurn = null;

      ws = next.writer;
      command = next.command;
      options = next.options;
      sessionSummary = next.options.sessionSummary;
      turnCompleteSent = false;
      assistantBudgetSent = false;
      turnSawTaskNotification = false;
      turnAssistantText = '';
      turnToolUseCount = 0;
      pendingIdleResend = false;
      heldForBackgroundWork = false;
      if (idleReleaseTimer) {
        clearTimeout(idleReleaseTimer);
        idleReleaseTimer = null;
      }
      turnResolvers.push(next.resolve);
      const session = getSession(sessionKey());
      if (session?.instance === queryInstance) session.writer = ws;
      if (capturedSessionId && typeof ws.setSessionId === 'function') ws.setSessionId(capturedSessionId);
      // The new turn's writer starts from the strip as it stands.
      broadcastBackgroundTasks();
      heldPrompt.push(next.promptMessages);
    };
    const runPendingTurn = () => {
      startPendingTurn().catch((error) => {
        // Never an unhandled rejection: report on whichever writer the turn
        // reached, and end every turn still owed an answer.
        console.error('[Claude SDK] Failed to hand a turn to the held process:', error);
        const next = pendingTurn;
        pendingTurn = null;
        if (next) moveTurnToFreshProcess(next);
        resolveTurns();
      });
    };

    // Takes a later turn of this session while the process is held for its
    // background work. Null when it cannot: a reply is still running, stdin
    // is closed, the run was stopped or superseded, another turn is already
    // waiting, or the turn needs a process started differently (directory,
    // tool permissions, MCP, ultracode; leaving plan mode a process started
    // in; turning on bypass permissions; back to the default effort from a process started with `--effort`,
    // which `effortLevel: null` would not undo). A turn arriving while the
    // CLI is inside a turn — relaying a finished task, or ending the reply
    // the user just stopped — waits for that turn's `result`, so it is never
    // folded into it.
    const continueTurn = (next) => {
      const awaitingStoppedResult = turnOnlyAbortTokens.has(queryInstance);
      if ((!turnCompleteSent && !awaitingStoppedResult) || pendingTurn || processGoingAway()
        || next.compatibilityKey !== compatibilityKey
        || (startedInPlan && next.sdkOptions.permissionMode !== 'plan')
        // Measured: the CLI refuses bypass unless launched with it.
        || (!startedWithBypass && next.sdkOptions.permissionMode === 'bypassPermissions')
        || (startedWithEffort && next.sdkOptions.effort === undefined && next.modelTakesEffort)) {
        return null;
      }
      return new Promise((resolve) => {
        pendingTurn = { ...next, resolve };
        if (!cliTurnActive && !awaitingStoppedResult) runPendingTurn();
      });
    };
    // A stop that arrives while a handed-over turn still waits to be written
    // withdraws just that turn.
    const withdrawPendingTurn = () => {
      const next = pendingTurn;
      if (!next) return false;
      pendingTurn = null;
      next.resolve();
      return true;
    };
    const turnHooks = { isTurnInFlight, continueTurn, withdrawPendingTurn };
    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, releasePromptStream, turnHooks);
    }
    // The new owner clears stale cards even if its turn starts no background work.
    broadcastBackgroundTasks();

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      subagentOrigins.observe(message);
      // Late output from an interrupted run must never mutate the new run's
      // task state or clear its cards on the shared session stream.
      const current = getSession(sessionKey());
      if (current && current.instance !== queryInstance) supersededInstances.add(queryInstance);
      if (supersededInstances.has(queryInstance)
        || (!current && abortedInstances.has(queryInstance))) break;
      if (message.type === 'system' && message.subtype === 'init') {
        cliTurnActive = true;
      }
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey(), queryInstance, ws, releasePromptStream, turnHooks);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      const tokenBudgetData = extractTokenBudget(message)
        || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message));
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (isTaskNotificationUserMessage(message)) {
        turnSawTaskNotification = true;
      }

      // Main-thread assistant blocks only: subagent traffic (parent_tool_use_id
      // set) is reported through the main thread's own tool calls, which are
      // counted there.
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text') {
              turnAssistantText += (turnAssistantText ? '\n' : '') + (block.text || '');
            } else if (block?.type === 'tool_use') {
              turnToolUseCount += 1;
            }
          }
        }
      }

      // Nested and untracked tasks report elsewhere, so only main-thread work
      // waits for a reply; the check must precede `apply`, which drops the record.
      const expectsBackgroundReply = backgroundWork.settlesMainThreadWork(sessionKey(), message);
      const taskCardsChanged = backgroundWork.apply(sessionKey(), message);
      const wakeupsExpired = backgroundWork.expireWakeups(sessionKey());
      if (wakeupsExpired || expectsBackgroundReply) backgroundReplyPending = true;
      if (taskCardsChanged || wakeupsExpired || expectsBackgroundReply) broadcastBackgroundTasks();
      scheduleWakeupCardExpiry();

      // A task the user stopped gets no follow-up turn from the CLI — only its
      // `stopped` notification — so when that was the last outstanding task
      // nothing will ever push the `result` the release below waits for, and
      // the process would sit until the idle ceiling. Release it here. A
      // completed task is different: the CLI relays its result in a turn of
      // its own, which closing stdin now would cut short.
      if (
        heldForBackgroundWork
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && message.status === 'stopped'
        && !backgroundWork.hasPending(sessionKey())
        && !backgroundReplyPending
        && !pendingTurn
      ) {
        heldForBackgroundWork = false;
        releasePromptStream();
      }

      if (message.type === 'result') {
        cliTurnActive = false;
        // The turn the user stopped ends here. The abort already told the
        // client it was over, so from now on this run is in its post-turn
        // hold like any other, and later results are background replies.
        if (turnOnlyAbortTokens.delete(queryInstance)) {
          abortedInstances.delete(queryInstance);
          turnCompleteSent = true;
          resolveTurns();
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            stopReason: 'aborted'
          });
        }
        backgroundReplyPending = false;
        const workLapsed = backgroundWork.endTurn(sessionKey());
        if (workLapsed || (lastBroadcastPending && !backgroundWork.hasPending(sessionKey()))) broadcastBackgroundTasks();
        // The turn is done as far as the client is concerned.
        const abortPending = sessionKey() ? abortedInstances.has(queryInstance) : false;
        const stillOutstanding = backgroundWork.hasPending(sessionKey());
        if (!turnCompleteSent && !abortPending) {
          pendingIdleResend = shouldResendPromptForIdleTurn({
            hasPrompt: typeof command === 'string' && command.trim().length > 0,
            sawTaskNotification: turnSawTaskNotification,
            assistantText: turnAssistantText,
            toolUseCount: turnToolUseCount
          });
          turnCompleteSent = true;
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
          resolveTurns();
          if (!pendingIdleResend) {
            notifyRunStopped({
              userId: ws?.userId || null,
              provider: 'claude',
              sessionId: sessionId || capturedSessionId || null,
              sessionName: sessionSummary,
              stopReason: 'completed'
            });
          }
        } else if (heldForBackgroundWork && !abortPending && !stillOutstanding) {
          // A result after the turn already reported complete means the work we
          // held the process open for has finished and pushed a follow-up turn
          // — the last of it, when nothing else is still running.
          notifyBackgroundWorkCompleted({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary
          });
        }
        // Work started during this turn, or work from an earlier turn that
        // has not settled yet (a follow-up turn reports one task in while
        // another is still going), is still running. Hold the process open
        // so it can finish and report back in a follow-up turn; the ceiling
        // is only a backstop for work that never reports.
        //
        // The release when the last task settles is this same branch on the
        // follow-up turn the CLI pushes for it, not the settling event
        // itself: closing stdin at that moment would cut the turn that
        // relays the task's result.
        //
        // Task events settle only their own calls. A simultaneous pending
        // wakeup or monitor still needs the process even after an agent ends.
        if (stillOutstanding) {
          heldForBackgroundWork = true;
          scheduleRelease();
        } else if (!pendingTurn) {
          // Either nothing was backgrounded, or the background work just
          // reported in — let the CLI exit now, as it always has.
          heldForBackgroundWork = false;
          if (lastBroadcastHadTasks) {
            broadcastBackgroundTasks();
          }
          releasePromptStream();
        }
        // A turn that waited for this turn to end goes in now.
        if (pendingTurn) runPendingTurn();
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedInstances.delete(queryInstance) : false;

    // The turn only acknowledged the injected task-notification and swallowed
    // the user's prompt. Re-run the prompt once on a fresh CLI process: the
    // notification now has its response recorded in the transcript, so the
    // resumed turn sees just the prompt and acts on it. Capped at one resend
    // so a CLI that keeps emitting placeholder turns cannot loop.
    if (pendingIdleResend && !superseded && !wasAborted && capturedSessionId && !options.idleResendAttempt) {
      console.log(`[Claude SDK] Session ${capturedSessionId} turn only acknowledged a task-notification; resending the prompt once`);
      return queryClaudeSDK(
        command,
        {
          ...options,
          providerSessionId: capturedSessionId,
          // The resend continues from the swallowed turn as-is; edit anchors
          // and scratch restarts belong to the original attempt only.
          resumeAnchorId: undefined,
          resumeFromScratch: undefined,
          idleResendAttempt: true
        },
        ws,
        context
      );
    }

    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    if (supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedInstances.delete(queryInstance) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    if (wakeupCardTimer) clearTimeout(wakeupCardTimer);
    if (!supersededInstances.has(queryInstance)
      && (!getSession(sessionKey()) || getSession(sessionKey())?.instance === queryInstance)) {
      backgroundReplyPending = false;
      backgroundWork.clear(sessionKey());
      if (lastBroadcastHadTasks || lastBroadcastPending) broadcastBackgroundTasks();
    }
    releasePromptStream();
    cancelRunApprovals(runToken);
    // Continued turns end with the process. One still waiting to go in never
    // reached it, so it runs on a fresh process instead.
    resolveTurns();
    if (pendingTurn) {
      const next = pendingTurn;
      pendingTurn = null;
      next.resolve(queryClaudeSDK(next.command, { ...next.options, skipHeldProcess: true }, next.writer, context));
    }
  }
}

/**
 * Hands a turn to the session's held process when it can take it (see
 * `continueTurn` in `queryClaudeSDK`). `turn` settles when that turn ends; it
 * is wrapped so awaiting this function does not wait the turn out. Null when
 * there is no such process or it cannot take this turn, and the caller starts
 * a fresh one.
 */
async function continueOnHeldProcess(command, options, writer, context, providerSessionId) {
  const sessionId = options.sessionId;
  if (!sessionId || options.skipHeldProcess || options.resumeAnchorId || options.resumeFromScratch) {
    return null;
  }
  const held = getSession(sessionId);
  if (!held?.continueTurn) {
    return null;
  }
  let prepared;
  try {
    prepared = await prepareTurnInputs(command, options, context, providerSessionId);
  } catch {
    // The fresh run surfaces the same failure to the client.
    return null;
  }
  // Another turn may have replaced the process while the inputs were read.
  if (getSession(sessionId) !== held) {
    return null;
  }
  const turn = held.continueTurn({ command, options, writer, ...prepared });
  return turn ? { turn } : null;
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  // A turn handed to the held process but not yet written into it (it waits
  // for the CLI's relay, or for a stopped reply, to end) is all there is to
  // stop: withdraw it and leave the process, that turn and its background
  // work alone. Checked first, so a stop aimed at it is never swallowed.
  if (session.withdrawPendingTurn?.()) {
    return true;
  }

  // The turn is already being stopped and only waits for its `result`; a
  // repeated press must not interrupt again or disturb that bookkeeping.
  if (turnOnlyAbortTokens.has(session.instance)) {
    return true;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // A reply stopped while background work it launched is still running
    // stops only the turn, as Esc does in the CLI: interrupt() leaves a
    // background Bash running (the CLI itself stops background agents and
    // reports them `stopped`), and closing stdin is what would kill the rest. Stopping in the
    // background phase itself (no reply in flight) still ends everything.
    const turnOnly = Boolean(session.isTurnInFlight?.()) && backgroundWork.hasPending(sessionId);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedInstances.add(session.instance);
    const turnOnlyToken = Symbol('turn-only-abort');
    if (turnOnly) turnOnlyAbortTokens.set(session.instance, turnOnlyToken);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    if (turnOnly) {
      const { instance } = session;
      setTimeout(() => {
        if (turnOnlyAbortTokens.get(instance) !== turnOnlyToken) return;
        turnOnlyAbortTokens.delete(instance);
        console.warn(`[Claude SDK] Session ${sessionId} never ended its interrupted turn; releasing the process`);
        session.releaseInput?.();
      }, TURN_ONLY_ABORT_RESULT_WAIT_MS).unref?.();
      return true;
    }

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
    session.releaseInput?.();

    // Update session status
    session.status = 'aborted';

    // A newer run may have taken the session id while interrupt was pending.
    if (getSession(sessionId)?.instance === session.instance) {
      removeSession(sessionId);
    }

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedInstances.delete(session.instance);
    turnOnlyAbortTokens.delete(session.instance);
    return false;
  }
}

/**
 * Sessions whose background tasks are still outstanding, with the tasks.
 *
 * A session stays here after its turn's `result` for as long as the process
 * is held open for the work — which is exactly the window in which nothing
 * else (the chat run registry marks the run completed at `result`) knows the
 * session is still busy.
 * @returns {Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>}
 */
function listClaudeSDKBackgroundWork() {
  const entries = backgroundWork.list();
  const listed = new Set(entries.map((entry) => entry.sessionId));
  // Waiting wakeups and follow-up replies are busy sessions without a live
  // task stop handle. Keep them in the off-screen queue's activity snapshot.
  for (const [sessionId, session] of activeSessions) {
    if (!listed.has(sessionId) && (backgroundWork.hasPending(sessionId) || session.backgroundReplyPending)) {
      entries.push({ sessionId, tasks: [] });
    }
  }
  return entries;
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
async function stopClaudeSDKTask(sessionId, taskId) {
  const session = getSession(sessionId);
  if (!session || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  await session.instance.stopTask(taskId);
  return true;
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * When the run behind a session started, or null when no run is up.
 *
 * The history reader uses this to tell a background agent launched by the
 * live process (still able to report back) from one launched by an earlier
 * process that has since exited (never will): a launch row older than the
 * live run cannot belong to it.
 * @param {string} sessionId - Session identifier
 * @returns {number|null} Epoch milliseconds the live run started, or null
 */
function getClaudeSDKSessionStartTime(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active' ? session.startTime : null;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

/**
 * Gets currently active background tasks for a session.
 * @param {string} sessionId - Session identifier
 * @returns {Array<import('../../../../shared/types.js').ActiveBackgroundTask>} Active background task records
 */
function getBackgroundTasksForSession(sessionId) {
  return getSession(sessionId) ? backgroundWork.activeTasks(sessionId) : [];
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  backgroundTasks: {
    list: getBackgroundTasksForSession,
    isPending: (sessionId) => Boolean(getSession(sessionId)
      && (backgroundWork.hasPending(sessionId) || getSession(sessionId).backgroundReplyPending)),
    // A message sent during background work becomes a turn of the held process.
    queuesInput: () => false,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  stopClaudeSDKTask,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  getBackgroundTasksForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};

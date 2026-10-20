/**
 * OpenCode Background Work
 *
 * OpenCode runs a `subagent` or `shell` call made with `background: true`
 * past the turn that made it. The call returns at once (`tool.success` with
 * `metadata.status: "running"`), the turn ends, and the work goes on: a
 * subagent in its own child session, a command as a shell job. When the work
 * ends the engine posts a synthetic notice into the parent session's inbox
 * (`session.inbox.enqueued`, `item.type: "synthetic"`, with
 * `payload.metadata` naming the work and its `state`) and starts a turn of
 * its own to report on it. The same notice is persisted as a `synthetic`
 * `session_message` row. Shapes verified live against v2.0.31.
 *
 * This module reads those shapes and keeps the record of what is still
 * running, so the runtime, the history reader and the running-sessions poll
 * agree on it.
 *
 * @module opencode-background-work
 */

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { BackgroundWorkRegistry } from '../../shared/background-work/background-work-registry.js';
import { LOCAL_AGENT_TASK_TYPE, LOCAL_BASH_TASK_TYPE } from '../../shared/background-work/task-status.js';

import { isOpenCodeSubagentTool } from './opencode-subagent.js';

/**
 * OpenCode work still running, keyed by app session id and then by the
 * engine's handle (the child session id of a subagent, the shell id of a
 * command).
 *
 * Process-wide by design: the engine is this server's child process, so work
 * nobody here tracks cannot be running anywhere. Fed and read by the opencode
 * runtime; read (`has`) by the opencode sessions provider, which tells a
 * background call that still runs from one whose process is gone.
 */
export const opencodeBackgroundWork = new BackgroundWorkRegistry();

/**
 * A call the engine moved to the background.
 *
 * Consumers: the opencode event translator (reads it off `tool.success`) and
 * the opencode run registry (records it).
 */
export type OpenCodeBackgroundLaunch = {
  /** The call that launched the work; its card shows the outcome. */
  callId: string;
  /** The engine's handle: the child session id of a subagent, the shell id of a command. */
  taskId: string;
  taskType: typeof LOCAL_AGENT_TASK_TYPE | typeof LOCAL_BASH_TASK_TYPE;
  description: string;
};

/** How background work ended, in `task_status` terms. */
export type OpenCodeBackgroundOutcome = 'completed' | 'failed' | 'stopped';

/**
 * The engine's word that one piece of background work ended.
 *
 * Consumers: the opencode event translator (live notices), the opencode
 * sessions provider and the runtime's reconciliation (persisted notices).
 */
export type OpenCodeBackgroundNotice = {
  taskId: string;
  outcome: OpenCodeBackgroundOutcome;
  /** When the engine wrote the notice (epoch ms); known for persisted notices only. */
  at?: number;
};

/**
 * The background launch a successful call reports, or null for a call that
 * finished in the foreground. A launch is a `subagent` call naming its child
 * session or a `shell` call naming its shell job, with the call's metadata
 * still saying `running`: a foreground call reports `completed` there.
 *
 * Consumer: the opencode event translator.
 */
export function readBackgroundLaunch(
  callId: string,
  engineToolName: string,
  input: unknown,
  metadata: unknown,
): OpenCodeBackgroundLaunch | null {
  const meta = readObjectRecord(metadata);
  if (readOptionalString(meta?.status) !== 'running') {
    return null;
  }
  const args = readObjectRecord(input);
  if (isOpenCodeSubagentTool(engineToolName)) {
    const childSessionId = readOptionalString(meta?.sessionID);
    return childSessionId
      ? {
        callId,
        taskId: childSessionId,
        taskType: LOCAL_AGENT_TASK_TYPE,
        description: readOptionalString(args?.description) ?? readOptionalString(args?.agent) ?? 'Subagent',
      }
      : null;
  }
  const shellId = readOptionalString(meta?.shellID);
  return shellId
    ? {
      callId,
      taskId: shellId,
      taskType: LOCAL_BASH_TASK_TYPE,
      description: readOptionalString(args?.description) ?? readOptionalString(args?.command) ?? shellId,
    }
    : null;
}

/**
 * Reads the notice in a synthetic inbox item's (or persisted synthetic
 * message's) metadata: `{ source: "subagent", childID, state }` or
 * `{ source: "shell", shellID, state }`. `completed` means the work ran to its
 * end (a command's exit code does not change that: the command did run),
 * `cancelled` means it was stopped, and any other state counts as a failure.
 *
 * Consumers: the opencode event translator and the opencode sessions provider.
 */
export function readBackgroundNotice(metadata: unknown): OpenCodeBackgroundNotice | null {
  const meta = readObjectRecord(metadata);
  const source = readOptionalString(meta?.source);
  const taskId = source === 'subagent'
    ? readOptionalString(meta?.childID)
    : source === 'shell' ? readOptionalString(meta?.shellID) : undefined;
  if (!taskId) {
    return null;
  }
  const state = readOptionalString(meta?.state);
  const outcome: OpenCodeBackgroundOutcome = state === 'completed'
    ? 'completed'
    : state === 'cancelled' ? 'stopped' : 'failed';
  return { taskId, outcome };
}

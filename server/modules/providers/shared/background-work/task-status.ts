import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/**
 * The `taskType` for an agent the engine runs as a child of the session,
 * matching what Claude's SDK names its local agents so the client labels
 * every engine's agent the same way.
 *
 * Consumers: the ZCode, OpenCode and Antigravity adapters.
 */
export const LOCAL_AGENT_TASK_TYPE = 'local_agent';

/** The `task_status` fields an engine adapter supplies per event. */
export type TaskStatusFields = Pick<NormalizedMessage, 'event' | 'description' | 'status' | 'summary' | 'usage' | 'outputFile'>
  & { id?: string; timestamp?: string };

/** What identifies the task a `task_status` event reports on. */
export type TaskStatusSubject = {
  provider: NormalizedMessage['provider'];
  sessionId: string | null;
  /** The engine's handle for the task (agent thread id, child session id, ...). */
  taskId: string;
  /** The `Agent` call that launched the task; the client folds the event onto that card. */
  toolUseId: string;
  taskType: string;
};

/**
 * Builds one `task_status` frame: the live word on a background task, which
 * the client folds onto the card of the call named by `toolUseId`.
 *
 * Consumers: the Codex, ZCode, OpenCode and Antigravity adapters, so every
 * engine speaks the same event shape and none keeps a private constructor.
 */
export function createTaskStatusMessage(subject: TaskStatusSubject, fields: TaskStatusFields): NormalizedMessage {
  return createNormalizedMessage({
    kind: 'task_status',
    ...subject,
    ...fields,
  });
}

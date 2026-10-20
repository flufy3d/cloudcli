import type { ActiveBackgroundTask, BackgroundTaskSummary, SessionBackgroundWork } from '@/shared/types.js';
import { SUBAGENT_TOOL_NAME } from '@/shared/utils.js';

import { LOCAL_BASH_TASK_TYPE } from './task-status.js';

/**
 * The background work a provider runtime still has outstanding, keyed by app
 * session id and then by task id.
 *
 * It is what a runtime's `listBackgroundWork()` answers the running-sessions
 * poll from, and what a history reader asks (`has`) to tell an agent whose
 * process is still alive from one whose process is gone. An engine whose
 * process outlives a turn (the ZCode engine) keeps agents here after the
 * turn's `complete`; an engine whose process dies with the turn (Codex's
 * app-server, Antigravity's `agy`) empties it when the process ends, settling
 * each leftover card.
 *
 * Consumers: the Codex, ZCode, Antigravity and OpenCode runtime providers
 * (start/end/list/clear, and `listStripTasks` for the composer's strip) and
 * their sessions providers (`has`).
 */
export class BackgroundWorkRegistry {
  private readonly bySession = new Map<string, Map<string, BackgroundTaskSummary>>();

  /**
   * Records a task as running. A re-recorded start refreshes the entry in
   * place but keeps the original `startedAt`, so the strip's elapsed time
   * does not jump when an engine re-announces an agent.
   */
  start(sessionKey: string, task: Omit<BackgroundTaskSummary, 'startedAt'> & { startedAt?: number }): BackgroundTaskSummary {
    let tasks = this.bySession.get(sessionKey);
    if (!tasks) {
      tasks = new Map();
      this.bySession.set(sessionKey, tasks);
    }
    const previous = tasks.get(task.taskId);
    const entry: BackgroundTaskSummary = {
      ...task,
      startedAt: previous?.startedAt ?? task.startedAt ?? Date.now(),
    };
    tasks.set(task.taskId, entry);
    return entry;
  }

  /** Retires one task; returns what was recorded for it, if anything. */
  end(sessionKey: string, taskId: string): BackgroundTaskSummary | undefined {
    const tasks = this.bySession.get(sessionKey);
    const entry = tasks?.get(taskId);
    if (tasks && entry) {
      tasks.delete(taskId);
      if (tasks.size === 0) {
        this.bySession.delete(sessionKey);
      }
    }
    return entry;
  }

  /** The recorded task, when the session still has it outstanding. */
  get(sessionKey: string, taskId: string): BackgroundTaskSummary | undefined {
    return this.bySession.get(sessionKey)?.get(taskId);
  }

  /** The running task with this id in any session. */
  find(taskId: string): { sessionKey: string; task: BackgroundTaskSummary } | undefined {
    for (const [sessionKey, tasks] of this.bySession) {
      const task = tasks.get(taskId);
      if (task) {
        return { sessionKey, task };
      }
    }
    return undefined;
  }

  /** Whether any session still has this task outstanding. */
  has(taskId: string): boolean {
    return this.find(taskId) !== undefined;
  }

  /** Whether the session has any work outstanding. */
  hasSession(sessionKey: string): boolean {
    return (this.bySession.get(sessionKey)?.size ?? 0) > 0;
  }

  /**
   * Drops every task of a session whose process is gone and returns what was
   * outstanding, so the caller can settle the cards of work that will never
   * report.
   */
  clearSession(sessionKey: string): BackgroundTaskSummary[] {
    const outstanding = Array.from(this.bySession.get(sessionKey)?.values() ?? []);
    this.bySession.delete(sessionKey);
    return outstanding;
  }

  /**
   * One session's tasks in the shape the composer's background-task strip
   * lists: a backgrounded command as `Bash`, anything else under its `Agent`
   * card. The strip offers a per-task stop only for a task carrying `taskId`,
   * so it is set only where `stopHandle` names a handle the runtime's
   * `stopBackgroundTask` accepts; Codex, ZCode and Antigravity cannot stop one
   * agent on its own and pass none.
   */
  listStripTasks(
    sessionKey: string,
    stopHandle?: (task: BackgroundTaskSummary) => string | undefined,
  ): ActiveBackgroundTask[] {
    return Array.from(this.bySession.get(sessionKey)?.values() ?? [], (task) => {
      const taskId = stopHandle?.(task);
      return {
        id: task.toolUseId,
        ...(taskId ? { taskId } : {}),
        toolName: task.taskType === LOCAL_BASH_TASK_TYPE ? 'Bash' : SUBAGENT_TOOL_NAME,
        command: task.description,
        description: task.description,
        startedAt: task.startedAt,
      };
    });
  }

  /** Every session with work outstanding, in the shape `listBackgroundWork` returns. */
  list(): SessionBackgroundWork[] {
    const entries: SessionBackgroundWork[] = [];
    for (const [sessionId, tasks] of this.bySession) {
      if (tasks.size > 0) {
        entries.push({ sessionId, tasks: Array.from(tasks.values()) });
      }
    }
    return entries;
  }
}

import type { BackgroundTaskSummary } from '@/shared/types.js';

/**
 * The background work a provider runtime still has outstanding, keyed by app
 * session id and then by task id.
 *
 * Engines whose process outlives a turn (Codex app-server, the ZCode engine)
 * keep running agents after the turn's `complete`; this registry is what their
 * `listBackgroundWork()` answers the running-sessions poll from, so the
 * composer's background-work strip and the sidebar keep naming that work
 * until the engine reports it done.
 *
 * Consumers: the Codex and ZCode runtime providers (start/end/list/clear) and
 * the ZCode sessions provider (`has`, to tell a still-running agent from one
 * whose process is gone when it replays history).
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

  /** Drops every task of a session whose process is gone. */
  clearSession(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }

  /** Every session with work outstanding, in the shape `listBackgroundWork` returns. */
  list(): Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> {
    const entries: Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> = [];
    for (const [sessionId, tasks] of this.bySession) {
      if (tasks.size > 0) {
        entries.push({ sessionId, tasks: Array.from(tasks.values()) });
      }
    }
    return entries;
  }
}

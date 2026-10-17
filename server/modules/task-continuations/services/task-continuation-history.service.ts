import path from 'node:path';

import { sessionsDb, taskContinuationDb } from '@/modules/database/index.js';
import { listCodexThreadTurns } from '@/modules/providers/index.js';
import type { TaskContinuationHistoryCheck } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

type CodexHistoryCheck = TaskContinuationHistoryCheck;

/** Finds a task result only in Codex's persisted functionCallOutput item. */
export function findCodexTaskResultInHistory(input: {
  eventId: string;
  taskId: string;
  turns: unknown[];
  expectedEngineTurnId?: string | null;
  expectedAttemptId?: string | null;
}): CodexHistoryCheck {
  const matches: Array<{ engineTurnId: string; status: NonNullable<CodexHistoryCheck['status']> }> = [];
  for (const turnValue of input.turns) {
    const turn = readObjectRecord(turnValue);
    if (!turn || typeof turn.id !== 'string'
      || !['completed', 'failed', 'interrupted', 'inProgress'].includes(String(turn.status))
      || !Array.isArray(turn.items)) {
      continue;
    }
    for (const itemValue of turn.items) {
      const item = readObjectRecord(itemValue);
      if (!item
        || item.type !== 'functionCallOutput'
        || item.name !== 'cloudcli_task_result'
        || typeof item.output !== 'string') {
        continue;
      }
      let output: unknown;
      try {
        output = JSON.parse(item.output);
      } catch {
        continue;
      }
      const outputRecord = readObjectRecord(output);
      if (outputRecord && outputRecord.eventId === input.eventId && outputRecord.taskId === input.taskId
        && (!input.expectedAttemptId || outputRecord.attemptId === input.expectedAttemptId)) {
        matches.push({
          engineTurnId: turn.id,
          status: turn.status as NonNullable<CodexHistoryCheck['status']>,
        });
      }
    }
  }

  if (matches.length !== 1) {
    if (matches.length > 1 || !input.expectedEngineTurnId) return { found: false };
    const expectedTurn = input.turns.map(readObjectRecord).find((value) => value?.id === input.expectedEngineTurnId);
    if (!expectedTurn
      || !['completed', 'failed', 'interrupted', 'inProgress'].includes(String(expectedTurn.status))) {
      return { found: false };
    }
    const status = expectedTurn.status as NonNullable<CodexHistoryCheck['status']>;
    if (status === 'completed') return { found: false, engineTurnId: input.expectedEngineTurnId, status };
    return { found: true, engineTurnId: input.expectedEngineTurnId, status };
  }
  return { found: true, ...matches[0] };
}

/** Builds a checker that proves task delivery from the owning Codex thread's persisted tool output. */
export function createCodexTaskHistoryChecker(dependencies: {
  getEventById: typeof taskContinuationDb.getEventById;
  getTaskById: typeof taskContinuationDb.getTaskById;
  getSessionById: typeof sessionsDb.getSessionById;
  listThreadTurns: typeof listCodexThreadTurns;
} = {
  getEventById: (eventId) => taskContinuationDb.getEventById(eventId),
  getTaskById: (taskId) => taskContinuationDb.getTaskById(taskId),
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  listThreadTurns: listCodexThreadTurns,
}): (eventId: string) => Promise<CodexHistoryCheck> {
  return async (eventId) => {
    const event = dependencies.getEventById(eventId);
    if (!event) return { found: false };
    const task = dependencies.getTaskById(event.task_id);
    if (!task || task.session_id !== event.session_id) return { found: false };
    const session = dependencies.getSessionById(task.session_id);
    if (session?.provider !== 'codex' || !task.provider_thread_id
      || session.provider_session_id !== task.provider_thread_id
      || !session.project_path
      || !task.session_project_path
      || path.resolve(session.project_path) !== path.resolve(task.session_project_path)) {
      return { found: false };
    }
    if (session.isArchived) {
      return { found: true, engineTurnId: event.engine_turn_id, status: 'paused' };
    }
    const nativeThreadId = task.provider_thread_id;
    if (!nativeThreadId) return { found: false };
    const turns = await dependencies.listThreadTurns(nativeThreadId);
    return findCodexTaskResultInHistory({
      eventId,
      taskId: task.task_id,
      expectedEngineTurnId: event.engine_turn_id,
      expectedAttemptId: event.host_run_id,
      turns,
    });
  };
}

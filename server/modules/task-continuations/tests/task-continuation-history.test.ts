import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCodexTaskHistoryChecker,
  findCodexTaskResultInHistory,
} from '@/modules/task-continuations/services/task-continuation-history.service.js';

test('history does not count a user message that merely mentions the continuation event id', () => {
  const result = findCodexTaskResultInHistory({
    eventId: 'event-history-1',
    taskId: 'task-history-1',
    turns: [{
      id: 'turn-user-message',
      status: 'completed',
      items: [{
        type: 'userMessage',
        content: [{ type: 'text', text: 'Please continue event-history-1' }],
      }],
    }],
  });

  assert.deepEqual(result, { found: false });
});

test('history checker reads only the event task owning Codex thread', async () => {
  const listedThreads: string[] = [];
  const checker = createCodexTaskHistoryChecker({
    getEventById: () => ({ event_id: 'event-owned', task_id: 'task-owned', session_id: 'session-owned' }) as any,
    getTaskById: () => ({
      task_id: 'task-owned', session_id: 'session-owned', provider_thread_id: 'native-thread-1',
      session_project_path: '/workspace/demo', engine_turn_id: null,
    }) as any,
    getSessionById: () => ({
      provider: 'codex', provider_session_id: 'native-thread-1', project_path: '/workspace/demo', isArchived: 0,
    }) as any,
    listThreadTurns: async (threadId) => {
      listedThreads.push(threadId);
      return [{
        id: 'turn-owned',
        status: 'completed',
        items: [{
          type: 'functionCallOutput',
          name: 'cloudcli_task_result',
          output: JSON.stringify({ eventId: 'event-owned', taskId: 'task-owned' }),
        }],
      }];
    },
  });

  assert.deepEqual(await checker('event-owned'), {
    found: true,
    engineTurnId: 'turn-owned',
    status: 'completed',
  });
  assert.deepEqual(listedThreads, ['native-thread-1']);
});

test('history matches only the exact task result tool output and returns its turn status', () => {
  const result = findCodexTaskResultInHistory({
    eventId: 'event-history-2',
    taskId: 'task-history-2',
    turns: [{
      id: 'turn-result',
      status: 'failed',
      items: [{
        type: 'functionCallOutput',
        name: 'cloudcli_task_result',
        output: JSON.stringify({ eventId: 'event-history-2', taskId: 'task-history-2' }),
      }],
    }],
  });

  assert.deepEqual(result, { found: true, engineTurnId: 'turn-result', status: 'failed' });
});

test('an accepted turn with no result tool output remains in progress only when its saved turn is active', () => {
  const result = findCodexTaskResultInHistory({
    eventId: 'event-in-progress',
    taskId: 'task-in-progress',
    expectedEngineTurnId: 'turn-active',
    turns: [{ id: 'turn-active', status: 'inProgress', items: [] }],
  });
  assert.deepEqual(result, { found: true, engineTurnId: 'turn-active', status: 'inProgress' });
});

test('manual retry history is matched to its own persisted attempt id', () => {
  const output = (attemptId: string) => ({
    type: 'functionCallOutput',
    name: 'cloudcli_task_result',
    output: JSON.stringify({ eventId: 'event-retried', taskId: 'task-retried', attemptId }),
  });
  const result = findCodexTaskResultInHistory({
    eventId: 'event-retried',
    taskId: 'task-retried',
    expectedAttemptId: 'attempt-second',
    turns: [
      { id: 'turn-first', status: 'failed', items: [output('attempt-first')] },
      { id: 'turn-second', status: 'completed', items: [output('attempt-second')] },
    ],
  });
  assert.deepEqual(result, { found: true, engineTurnId: 'turn-second', status: 'completed' });
});

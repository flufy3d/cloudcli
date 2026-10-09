import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  drain: () => Promise<void>;
  interrupt: () => Promise<void>;
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const drained = new Set<() => void>();
  const stopped: string[] = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stopped,
    interrupt: async () => {},
    drain: () => {
      if (wake && queue.length === 0) return new Promise((resolve) => setImmediate(resolve));
      return new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timeout); drained.delete(finish); setImmediate(resolve); };
        const timeout = setTimeout(() => {
          drained.delete(finish);
          reject(new Error('Scripted query did not finish processing its queued messages'));
        }, 5_000);
        drained.add(finish);
      });
    },
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const _message of prompt) { /* the CLI reads its stdin */ }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          for (const finish of drained) finish();
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          for (const finish of drained) finish();
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: () => script.interrupt(),
      stopTask: async (taskId: string) => { stopped.push(taskId); },
    });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: { script: Scripted; sent: NormalizedMessage[]; done: Promise<unknown> }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    try {
      await runTest({ script, sent, done });
    } finally {
      script.end();
      await done;
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

for (const toolName of ['Agent', 'Bash', 'Workflow']) {
  test(`${toolName} completion removes only its card while another task keeps running`, async () => {
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_done', toolName, { run_in_background: true }));
      script.emit(taskStarted('done', 'toolu_done', 'local_agent'));
      script.emit(toolUse('toolu_running', 'Agent', { run_in_background: true }));
      script.emit(taskStarted('running', 'toolu_running', 'local_agent'));
      script.emit(result());
      await script.drain();

      script.emit(taskNotification('done', 'toolu_done', 'completed'));
      await script.drain();

      const statuses = sent.filter((message) => message.kind === 'status' && message.text === 'background_tasks');
      assert.deepEqual(statuses.at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_running']);
      assert.equal(script.released(), false, 'the other task must keep running');
    });
  });
}

for (const status of ['completed', 'failed', 'killed', 'stopped']) {
  test(`a ${status} task patch clears the card even without a tool-use id`, async () => {
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_patch', 'Agent', { run_in_background: true }));
      script.emit(taskStarted('patched', 'toolu_patch', 'local_agent'));
      script.emit(result());
      await script.drain();
      script.emit({ type: 'system', subtype: 'task_updated', task_id: 'patched', patch: { status } });
      await script.drain();
      assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks, []);
    });
  });
}

test('a completion without tool_use_id resolves the card through task_started', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(result());
    await script.drain();
    script.emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
    await script.drain();
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks, []);
    assert.equal(script.released(), false, 'the follow-up reply must not be cut short');
    assert.equal(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundWorkPending, true);
    assert.ok(listClaudeSDKBackgroundWork().some((entry) => entry.sessionId === SESSION_ID), 'off-screen queue must wait for the reply too');
    script.emit(result());
    await script.drain();
    assert.equal(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundWorkPending, false);
  });
});

test('a new foreground-only run actively clears the old run\'s cards', async () => {
  await withRun(async ({ script: oldScript, done: oldDone }) => {
    oldScript.emit(init());
    oldScript.emit(toolUse('toolu_old', 'Agent', { run_in_background: true }));
    oldScript.emit(taskStarted('old', 'toolu_old', 'local_agent'));
    oldScript.emit(result());
    await oldScript.drain();
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(result());
      await script.drain();
      assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks, []);
      oldScript.end();
      await oldDone;
    });
  });
});

test('a rejected background call disappears without hiding a running sibling', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_running', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('running', 'toolu_running', 'local_agent'));
    script.emit(toolUse('toolu_rejected', 'ScheduleWakeup', { delaySeconds: 60 }));
    const rejected = ack('toolu_rejected', 'Permission denied', {});
    rejected.message.content[0] = { ...rejected.message.content[0], is_error: true } as never;
    script.emit(rejected);
    script.emit(result());
    await script.drain();
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_running']);
  });
});

test('wakeups expire at the acknowledged time while future wakeups and agents stay active', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_running', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('running', 'toolu_running', 'local_agent'));
    script.emit(toolUse('toolu_expired', 'ScheduleWakeup', { delaySeconds: 1 }));
    script.emit(ack('toolu_expired', 'Scheduled', { scheduledFor: Date.now() - 1 }));
    script.emit(toolUse('toolu_future', 'ScheduleWakeup', { delaySeconds: 1200 }));
    script.emit(ack('toolu_future', 'Scheduled', { scheduledFor: Date.now() + 120_000 }));
    script.emit(result());
    await script.drain();
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_running', 'toolu_future']);
    script.emit(taskNotification('running', 'toolu_running', 'completed'));
    script.emit(result());
    await script.drain();
    assert.equal(script.released(), false, 'the pending wakeup still needs the CLI alive');
  });
});

test('nested background calls do not create unlinked parent cards', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_parent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('parent', 'toolu_parent', 'local_agent'));
    script.emit({ ...toolUse('toolu_child', 'Bash', { run_in_background: true }), parent_tool_use_id: 'toolu_parent' });
    script.emit(taskStarted('child', 'toolu_child', 'local_bash'));
    script.emit(result());
    await script.drain();
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_parent']);
  });
});

test('an acknowledged wakeup expires even while the SDK stream is silent', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_timer', 'ScheduleWakeup', { delaySeconds: 60 }));
    script.emit(ack('toolu_timer', 'Scheduled', { scheduledFor: Date.now() + 300 }));
    script.emit(result());
    await script.drain();
    assert.equal(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.length, 1);
    const timeout = Date.now() + 1500;
    while (sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.length && Date.now() < timeout) {
      await script.drain();
    }
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks, []);
    assert.equal(script.released(), false, 'deadline expiry must not terminate the wakeup reply');
  });
});

test('superseded streams cannot clear or resurrect the new run\'s task cards', async () => {
  await withRun(async ({ script: oldScript, sent: oldSent, done: oldDone }) => {
    oldScript.emit(init());
    oldScript.emit(toolUse('toolu_old', 'Agent', { run_in_background: true }));
    oldScript.emit(taskStarted('old', 'toolu_old', 'local_agent'));
    oldScript.emit(result());
    await oldScript.drain();
    const oldCount = oldSent.length;
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_new', 'Agent', { run_in_background: true }));
      script.emit(taskStarted('new', 'toolu_new', 'local_agent'));
      script.emit(result());
      await script.drain();
      oldScript.emit(toolUse('toolu_late', 'Bash', { run_in_background: true }));
      oldScript.end();
      await oldDone;
      assert.equal(oldSent.length, oldCount, 'the old writer emits no late status or cleanup frame');
      assert.deepEqual(listClaudeSDKBackgroundWork().flatMap((entry) => entry.tasks.map((task) => task.taskId)), ['new']);
      assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_new']);
    });
  });
});

test('TaskCreate does not hold a finished turn open or block the composer', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_todo', 'TaskCreate', { subject: 'Plan work' }));
    script.emit(ack('toolu_todo', 'Created task', { task: { id: '1', subject: 'Plan work' } }));
    script.emit(result());
    await script.drain();
    assert.equal(script.released(), true);
    assert.equal(sent.some((message) => message.text === 'background_tasks' && message.backgroundTasks?.length), false);
  });
});

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await script.drain();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await script.drain();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

for (const completedWork of ['Agent', 'ScheduleWakeup']) {
  test(`stopping a sibling must not cut short an already pending ${completedWork} reply`, async () => {
    await withRun(async ({ script }) => {
      script.emit(init());
      for (const id of ['a', 'b']) {
        const tool = id === 'a' ? completedWork : 'Agent';
        script.emit(toolUse(`toolu_${id}`, tool, { run_in_background: true }));
        if (tool === 'Agent') script.emit(taskStarted(id, `toolu_${id}`, 'local_agent'));
      }
      script.emit(result());
      if (completedWork === 'Agent') script.emit(taskNotification('a', 'toolu_a', 'completed'));
      else script.emit(ack('toolu_a', 'Scheduled', { scheduledFor: Date.now() - 1 }));
      script.emit(taskNotification('b', 'toolu_b', 'stopped'));
      await script.drain();
      assert.equal(script.released(), false, 'A still needs its follow-up reply');
      script.emit(result());
      await script.drain();
      assert.equal(script.released(), true);
    });
  });
}

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await script.drain();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await script.drain();
    assert.equal(script.released(), false);

    script.emit(result());
    await script.drain();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await script.drain();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await script.drain();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

const lastStatus = (sent: NormalizedMessage[]) => sent.filter((message) => message.text === 'background_tasks').at(-1);

test('a late duplicate abort and the old stream cleanup cannot remove a newer run', async () => {
  await withRun(async ({ script: oldScript, done: oldDone }) => {
    oldScript.emit(init());
    oldScript.emit(toolUse('toolu_old', 'Agent', { run_in_background: true }));
    oldScript.emit(taskStarted('old', 'toolu_old', 'local_agent'));
    oldScript.emit(result());
    await oldScript.drain();
    let releaseInterrupt!: () => void;
    const delayedInterrupt = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    let interrupts = 0;
    oldScript.interrupt = () => ++interrupts === 1 ? Promise.resolve() : delayedInterrupt;
    const firstAbort = abortClaudeSDKSession(SESSION_ID);
    const lateAbort = abortClaudeSDKSession(SESSION_ID);
    assert.equal(await firstAbort, true);
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_new', 'Agent', { run_in_background: true }));
      script.emit(taskStarted('new', 'toolu_new', 'local_agent'));
      script.emit(result());
      await script.drain();
      assert.ok(sent.some((message) => message.kind === 'complete'), 'an old abort flag must not suppress the new turn complete');
      releaseInterrupt();
      assert.equal(await lateAbort, true);
      assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['new']]);
      oldScript.end();
      await oldDone;
      assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['new']]);
      assert.equal(await stopClaudeSDKTask(SESSION_ID, 'new'), true, 'the new run must retain its stop handle');
    });
  });
});

test('late messages from an aborted old stream cannot settle a new run cron', async () => {
  await withRun(async ({ script: oldScript, done: oldDone }) => {
    oldScript.emit(init());
    oldScript.emit(result());
    await oldScript.drain();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await withRun(async ({ script }) => {
      script.emit(init());
      script.emit(toolUse('toolu_cron', 'CronCreate', { cron: '* * * * *', prompt: 'ping' }));
      script.emit(ack('toolu_cron', 'created', { id: 'cron-new' }));
      script.emit(result());
      await script.drain();
      assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.sessionId), [SESSION_ID]);
      oldScript.emit(result());
      oldScript.end();
      await oldDone;
      assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.sessionId), [SESSION_ID]);
      assert.equal(script.released(), false, 'the new cron still needs its held process');
    });
  });
});

test('a rejected SDK interrupt leaves its tasks stoppable and allows the turn to report completion', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    await script.drain();
    script.interrupt = async () => { throw new Error('interrupt rejected'); };
    assert.equal(await abortClaudeSDKSession(SESSION_ID), false);
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'a1'), true);
    script.emit(result());
    await script.drain();
    assert.ok(sent.some((message) => message.kind === 'complete'), 'a failed cancel must not suppress completion');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['a1']]);
  });
});

test('aborting a held background reply releases stdin and broadcasts the cleared queue gate', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(result());
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    await script.drain();
    assert.equal(lastStatus(sent)?.backgroundWorkPending, true);
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    script.end();
    await done;
    assert.equal(script.released(), true);
    assert.deepEqual(lastStatus(sent)?.backgroundTasks, []);
    assert.equal(lastStatus(sent)?.backgroundWorkPending, false);
  });
});

test('a nested task finishing does not keep the process waiting after its parent is stopped', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_parent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('parent', 'toolu_parent', 'local_agent'));
    script.emit(result());
    await script.drain();
    script.emit(taskStarted('child', 'toolu_child', 'local_bash'));
    script.emit(taskNotification('child', 'toolu_child', 'completed'));
    script.emit(taskNotification('parent', 'toolu_parent', 'stopped'));
    await script.drain();
    assert.equal(script.released(), true);
    assert.equal(lastStatus(sent)?.backgroundWorkPending, false);
  });
});

test('an untracked CLI task finishing does not keep the process waiting', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_a', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('a', 'toolu_a', 'local_agent'));
    script.emit(result());
    await script.drain();
    script.emit({ type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: 'housekeeping', status: 'completed' });
    script.emit(taskNotification('a', 'toolu_a', 'stopped'));
    await script.drain();
    assert.equal(script.released(), true);
    assert.equal(lastStatus(sent)?.backgroundWorkPending, false);
  });
});

for (const [toolName, input, output] of [
  ['CronCreate', { cron: '* * * * *', prompt: 'ping', recurring: false }, { id: 'job1', recurring: false }],
  ['CronCreate', { cron: '* * * * *', prompt: 'ping', recurring: true }, { id: 'job1', recurring: true }],
  ['ScheduleWakeup', { delaySeconds: 60 }, {}],
] as const) {
  test(`${toolName} ${JSON.stringify(output)} lets go after the turn it triggers`, async () => {
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_x', toolName, input));
      script.emit(ack('toolu_x', 'ok', output));
      script.emit(result());
      await script.drain();
      assert.equal(script.released(), false, 'the launching turn holds for it');
      script.emit(result());
      await script.drain();
      assert.equal(script.released(), true);
      assert.deepEqual(lastStatus(sent)?.backgroundTasks, []);
      assert.equal(lastStatus(sent)?.backgroundWorkPending, false);
    });
  });
}

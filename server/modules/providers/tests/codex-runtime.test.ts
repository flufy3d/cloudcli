/**
 * The Codex runtime drives one turn over `codex app-server`.
 *
 * The fake below answers the three requests a turn makes and replays the
 * notifications a real turn sends, in the order and shape captured from a
 * live `codex app-server` session.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexAppServerTransport,
  type CodexAppServerHandlers,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

const THREAD_ID = '01a0c4d2-a3c3-7510-8e3f-c36245fa5d9d';
const TURN_ID = '01a0c4d2-a3fe-7330-bb87-5a99871777d0';

type FakeServer = {
  calls: Array<{ method: string; params: any }>;
  handlers: CodexAppServerHandlers;
};

/**
 * Installs a fake app-server for the duration of one test and returns what it
 * was asked to do.
 */
function installFakeAppServer(
  t: any,
  script: (server: FakeServer) => void = replayOneTurn,
): FakeServer {
  const server: FakeServer = { calls: [], handlers: {} };

  t.mock.method(codexAppServerTransport, 'open', async (handlers: CodexAppServerHandlers) => {
    server.handlers = handlers;
    return {
      async call(method: string, params: unknown) {
        server.calls.push({ method, params });
        if (method === 'thread/start' || method === 'thread/resume') {
          return { thread: { id: THREAD_ID } };
        }
        if (method === 'turn/start') {
          // The server answers immediately and reports the turn's progress
          // through notifications.
          queueMicrotask(() => script(server));
          return { turn: { id: TURN_ID, status: 'inProgress' } };
        }
        return {};
      },
      close() {},
    };
  });

  return server;
}

/** The notification sequence one short turn produces. */
function replayOneTurn(server: FakeServer): void {
  const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
  notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
  notify('item/completed', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: {
      type: 'agentMessage',
      id: 'msg_02c8dbf5b38a0554016ab15ce008f487d08eeca161bae5821c',
      text: 'done',
      phase: 'final_answer',
    },
  });
  notify('thread/tokenUsage/updated', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    tokenUsage: { total: { totalTokens: 15620, inputTokens: 15614, outputTokens: 6 }, modelContextWindow: 258400 },
  });
  notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
}

function runtimeContext(resumed: boolean): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => resumed ? THREAD_ID : null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    // The runtime's rows are already normalized shapes; passing them straight
    // through keeps this test about the transport, not the renderer.
    normalizeMessage: (row: any) => [row],
    isProviderInstalled: async () => true,
  };
}

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      const server = installFakeAppServer(t);
      const messages: any[] = [];

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(resumed));

      const opener = server.calls.find((call) => call.method === 'thread/start' || call.method === 'thread/resume');
      assert.ok(opener);
      assert.equal(opener.method, resumed ? 'thread/resume' : 'thread/start');
      assert.equal(opener.params.sandbox, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(
        opener.params.approvalPolicy,
        permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request',
      );

      const turn = server.calls.find((call) => call.method === 'turn/start');
      assert.ok(turn);
      assert.deepEqual(turn.params.input, [{ type: 'text', text: 'hey there', text_elements: [] }]);

      assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message) => message.kind === 'error'));
    });
  }
}

test('the live reply carries the item id the rollout will record', async (t) => {
  installFakeAppServer(t);
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const reply = messages.find((message) => message.type === 'assistant');
  assert.ok(reply, 'the turn must produce an assistant row');
  assert.equal(reply.uuid, 'msg_02c8dbf5b38a0554016ab15ce008f487d08eeca161bae5821c');
});

test('assistant text streams before its item completes, under one id', async (t) => {
  const server = installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/started', { item: { type: 'agentMessage', id: 'msg_stream', text: '' } });
    notify('item/agentMessage/delta', { itemId: 'msg_stream', delta: 'par' });
    notify('item/agentMessage/delta', { itemId: 'msg_stream', delta: 'tial' });
    notify('item/completed', { item: { type: 'agentMessage', id: 'msg_stream', text: 'partial answer' } });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const replies = messages.filter((message) => message.type === 'assistant');
  assert.deepEqual(replies.map((row) => row.message.content), ['par', 'partial', 'partial answer']);
  // One row, updated three times — the id is what makes that true.
  assert.deepEqual([...new Set(replies.map((row) => row.uuid))], ['msg_stream']);
  assert.ok(server.calls.some((call) => call.method === 'turn/start'));
});

test('a failed turn surfaces the error and exits non-zero', async (t) => {
  installFakeAppServer(t, (fake) => {
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'failed', error: { message: 'usage limit reached' } },
    } as any);
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  assert.ok(messages.some((message) => message.kind === 'error' && message.content === 'usage limit reached'));
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 1));
});

test('an approval nobody can answer is refused rather than left to block the turn', async (t) => {
  let decision: unknown;
  installFakeAppServer(t, (fake) => {
    decision = fake.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'exec-1',
      startedAtMs: 0,
      kind: 'command',
    } as any);
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'completed', error: null },
    } as any);
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  assert.deepEqual(decision, { decision: 'decline' });
  const note = messages.find((message) => message.kind === 'task_notification');
  assert.ok(note, 'the refusal must be visible in the transcript');
  assert.equal(note.id, 'exec-1_approval');
});

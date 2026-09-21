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

/** Waits for something the run produces asynchronously. */
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the expected value never arrived');
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

test('streamed prose rides stream_delta and lands as exactly one row', async (t) => {
  installFakeAppServer(t, (fake) => {
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

  // The fragments are stream frames, which the client grows into one
  // placeholder. Sending them as text rows instead appends one message per
  // fragment — which is exactly what shipped and had to be undone.
  assert.deepEqual(
    messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content),
    ['par', 'tial'],
  );
  const replies = messages.filter((message) => message.type === 'assistant');
  assert.equal(replies.length, 1, 'a streamed reply must produce exactly one transcript row');
  assert.equal(replies[0].uuid, 'msg_stream');
  assert.equal(replies[0].message.content, 'partial answer');
});

test('an item that starts empty is not announced before it has content', async (t) => {
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    // A prompt echo announced on both start and completion would be appended
    // twice; only the completion is forwarded.
    const userMessage = {
      type: 'userMessage',
      id: '01a0c4d2-b0a4-7991-85e5-931b865e6ed0',
      content: [{ type: 'text', text: 'hey there', text_elements: [] }],
    };
    notify('item/started', { item: userMessage });
    notify('item/completed', { item: userMessage });
    // A shell command is worth showing while it runs, so both are forwarded
    // and the client merges them on the shared tool id.
    const command = { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'ls'" };
    notify('item/started', { item: { ...command, status: 'inProgress' } });
    notify('item/completed', { item: { ...command, status: 'completed', aggregatedOutput: 'a.txt\n', exitCode: 0 } });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  assert.equal(messages.filter((message) => message.type === 'user').length, 1);
  assert.equal(messages.filter((message) => message.type === 'tool_use').length, 2);
  assert.deepEqual(
    [...new Set(messages.filter((message) => message.type === 'tool_use').map((row) => row.toolCallId))],
    ['exec-1'],
  );
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

test('an approval waits for the user and carries the command it is about', async (t) => {
  let answer: Promise<unknown> | undefined;
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    // A command approval is asked before the item is ever announced, and
    // carries the command it wants to run (captured from a real request).
    answer = Promise.resolve(fake.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'exec-1',
      startedAtMs: 0,
      kind: 'command',
      reason: 'needs network access',
      command: "/bin/zsh -lc 'rm -rf /etc'",
      cwd: '/tmp',
    } as any));
    // The turn only ends once the approval has been answered.
    void answer.then(() => notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'completed', error: null },
    }));
  });
  const messages: any[] = [];

  const run = codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  // The prompt reaches the client before anything answers it.
  const prompt = await waitFor(() => messages.find((message) => message.kind === 'permission_request'));
  assert.equal(prompt.toolName, 'Bash');
  assert.deepEqual(JSON.parse(String(prompt.input)), { command: 'rm -rf /etc' });
  assert.equal(prompt.context.reason, 'needs network access');
  assert.equal(prompt.canInterrupt, true);

  // It is listed as pending for the session until it is answered.
  assert.equal(codexRuntime.permissions.listPending('app-session').length, 1);

  codexRuntime.permissions.resolve(prompt.requestId, { allow: true });
  await run;

  assert.deepEqual(await answer, { decision: 'accept' });
  assert.ok(messages.some((message) => message.kind === 'permission_resolved' && message.requestId === prompt.requestId));
  assert.equal(codexRuntime.permissions.listPending('app-session').length, 0);
});

test('remembering an approval grants it for the whole session', async (t) => {
  let answer: Promise<unknown> | undefined;
  installFakeAppServer(t, (fake) => {
    answer = Promise.resolve(fake.handlers.onRequest?.('item/fileChange/requestApproval', {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-2', startedAtMs: 0,
    } as any));
    void answer.then(() => fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any));
  });
  const messages: any[] = [];

  const run = codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const prompt = await waitFor(() => messages.find((message) => message.kind === 'permission_request'));
  codexRuntime.permissions.resolve(prompt.requestId, { allow: true, rememberEntry: 'codex:fileChange' });
  await run;

  assert.deepEqual(await answer, { decision: 'acceptForSession' });
});

test('a denied approval is declined, and one nobody answers is retracted', async (t) => {
  let denied: Promise<unknown> | undefined;
  installFakeAppServer(t, (fake) => {
    denied = Promise.resolve(fake.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-3', startedAtMs: 0, kind: 'command',
    } as any));
    void denied.then(() => fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any));
  });
  const messages: any[] = [];

  const run = codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const prompt = await waitFor(() => messages.find((message) => message.kind === 'permission_request'));
  codexRuntime.permissions.resolve(prompt.requestId, { allow: false });
  await run;
  assert.deepEqual(await denied, { decision: 'decline' });

  // A run that ends with a prompt still open must retract it, or the card
  // hangs in the transcript forever.
  let orphan: Promise<unknown> | undefined;
  const second: any[] = [];
  installFakeAppServer(t, (fake) => {
    orphan = Promise.resolve(fake.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-4', startedAtMs: 0, kind: 'command',
    } as any));
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any);
  });

  await codexRuntime.run('hey there', {
    sessionId: 'app-session-2',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => second.push(message) }, runtimeContext(true));

  assert.ok(second.some((message) => message.kind === 'permission_cancelled'));
  assert.deepEqual(await orphan, { decision: 'decline' });
  assert.equal(codexRuntime.permissions.listPending('app-session-2').length, 0);
});

test('a request that is not an approval is reported as unimplemented', async (t) => {
  let answer: unknown = 'unset';
  installFakeAppServer(t, (fake) => {
    answer = fake.handlers.onRequest?.('mcpServer/elicitation/request', { threadId: THREAD_ID } as any);
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any);
  });

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: () => {} }, runtimeContext(true));

  assert.equal(await answer, undefined);
});

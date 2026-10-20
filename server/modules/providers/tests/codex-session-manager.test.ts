/**
 * The resident session manager owns one `codex app-server` process per app
 * session and submits rounds through the engine's queue.
 *
 * The fake below answers the requests the manager makes and replays the
 * notifications a real app-server sends, in the order captured from a live
 * session: the queue reports the consumption of a queued input before the
 * turn that input produced is announced.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexAppServerTransport,
  type CodexAppServerHandlers,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import {
  acquireCodexResidentSession,
  closeCodexResidentSessions,
  completeCodexResidentRound,
  isCodexResidentSessionBusy,
  listCodexResidentSessions,
  stopCodexResidentRound,
  submitCodexResidentRound,
} from '@/modules/providers/list/codex/codex-session-manager.js';

const THREAD_ID = '01a0c4d2-a3c3-7510-8e3f-c36245fa5d9d';

type FakeServer = {
  calls: Array<{ method: string; params: any }>;
  handlers: CodexAppServerHandlers;
  closed: boolean;
  openOptions?: unknown;
  /** The queued items the fake engine holds, keyed by the client message id. */
  queue: Map<string, { id: string; clientUserMessageId: string }>;
};

const notify = (server: FakeServer, method: string, params: unknown): void => {
  server.handlers.onNotification?.(method, params as any);
};

/** Installs a fake app-server and returns what it was asked to do. */
function installFakeAppServer(t: any): FakeServer {
  const server: FakeServer = { calls: [], handlers: {}, closed: false, queue: new Map() };

  t.mock.method(codexAppServerTransport, 'open', async (
    handlers: CodexAppServerHandlers,
    openOptions?: unknown,
  ) => {
    server.handlers = handlers;
    server.openOptions = openOptions;
    return {
      async call(method: string, params: any) {
        server.calls.push({ method, params });
        if (method === 'thread/start' || method === 'thread/resume') {
          // A thread takes the sandbox mode as a string; the policy object
          // belongs to a turn, and the engine ignores it here.
          assert.ok(
            params.sandbox === 'workspace-write' || params.sandbox === 'danger-full-access',
            `thread/${method} needs a sandbox mode, got ${JSON.stringify(params.sandbox)}`,
          );
          assert.equal(params.sandboxPolicy, undefined);
          return { thread: { id: THREAD_ID } };
        }
        if (method === 'thread/settings/update') {
          // A turn's settings take the policy object, which is tagged by its
          // type; a mode string is rejected by the engine.
          assert.ok(params.sandboxPolicy, 'thread/settings/update needs a sandbox policy');
          assert.equal(typeof params.sandboxPolicy.type, 'string');
          assert.equal(params.sandboxPolicy.mode, undefined);
          return {};
        }
        if (method === 'thread/queue/add') {
          const id = `queued-${server.queue.size + 1}`;
          server.queue.set(params.clientUserMessageId, { id, clientUserMessageId: params.clientUserMessageId });
          return { queuedSubmission: { id, input: params.input, clientUserMessageId: params.clientUserMessageId } };
        }
        if (method === 'thread/queue/list') {
          return { data: [...server.queue.values()], nextCursor: null };
        }
        if (method === 'thread/queue/delete') {
          for (const [key, item] of server.queue) {
            if (item.id === params.queuedSubmissionId) {
              server.queue.delete(key);
            }
          }
          return {};
        }
        return {};
      },
      close() { server.closed = true; },
    };
  });

  return server;
}

/** The engine consuming a queued input: the item goes, then the turn starts. */
function drainQueue(server: FakeServer, turnId: string, threadId = THREAD_ID): void {
  const [key] = [...server.queue.keys()];
  if (key) {
    server.queue.delete(key);
  }
  notify(server, 'thread/queue/changed', { threadId });
  notify(server, 'turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
}

test('two concurrent borrows of one app session open a single process', async (t) => {
  const server = installFakeAppServer(t);
  try {
    const [first, second] = await Promise.all([
      acquireCodexResidentSession({
        appSessionId: 'app-1',
        nativeThreadId: null,
        workingDirectory: '/tmp',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      }),
      acquireCodexResidentSession({
        appSessionId: 'app-1',
        nativeThreadId: null,
        workingDirectory: '/tmp',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      }),
    ]);

    assert.equal(first.connection, second.connection);
    assert.equal(first.threadId, THREAD_ID);
    assert.equal(server.calls.filter((call) => call.method === 'thread/start').length, 1);
  } finally {
    closeCodexResidentSessions();
  }
});

test('a later round of the same app session reuses the process and the thread', async (t) => {
  const server = installFakeAppServer(t);
  try {
    const first = await acquireCodexResidentSession({
      appSessionId: 'app-2',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    const second = await acquireCodexResidentSession({
      appSessionId: 'app-2',
      nativeThreadId: first.threadId,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    assert.equal(second.connection, first.connection);
    assert.equal(second.generation, first.generation);
    assert.equal(server.calls.filter((call) => call.method === 'thread/start').length, 1);
    assert.equal(server.calls.filter((call) => call.method === 'thread/resume').length, 0);
  } finally {
    closeCodexResidentSessions();
  }
});

test('a round is written to the engine queue instead of starting a turn', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-3',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    const roundEvents: string[] = [];
    await submitCodexResidentRound({
      appSessionId: 'app-3',
      input: [{ type: 'text', text: 'hello' }],
      model: 'test-model',
      effort: 'low',
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEvent: (method) => roundEvents.push(method),
      onRequest: () => undefined,
    });

    const methods = server.calls.map((call) => call.method);
    assert.ok(methods.includes('thread/settings/update'));
    assert.ok(methods.includes('thread/queue/add'));
    assert.ok(!methods.includes('turn/start'));

    const settings = server.calls.find((call) => call.method === 'thread/settings/update');
    assert.equal(settings?.params.model, 'test-model');
    assert.equal(settings?.params.effort, 'low');

    const added = server.calls.find((call) => call.method === 'thread/queue/add');
    assert.equal(added?.params.input[0].text, 'hello');
    assert.equal(typeof added?.params.clientUserMessageId, 'string');
  } finally {
    closeCodexResidentSessions();
  }
});

test('the turn that follows the consumption of the queued input is the round own turn', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-4',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEngineEvent: () => {},
    });

    const roundEvents: string[] = [];
    const engineEvents: string[] = [];
    await acquireCodexResidentSession({
      appSessionId: 'app-4',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEngineEvent: (method) => engineEvents.push(method),
    });

    await submitCodexResidentRound({
      appSessionId: 'app-4',
      input: [{ type: 'text', text: 'hello' }],
      onEvent: (method) => roundEvents.push(method),
      onRequest: () => undefined,
    });

    drainQueue(server, 'turn-1');

    // The consumption is observed asynchronously, so the turn that follows it
    // may arrive before the round is armed.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(roundEvents, ['turn/started']);
    assert.deepEqual(engineEvents, []);
  } finally {
    closeCodexResidentSessions();
  }
});

test('a turn the engine starts on its own never reaches the round', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-5',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    const roundEvents: string[] = [];
    const engineEvents: string[] = [];
    await acquireCodexResidentSession({
      appSessionId: 'app-5',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEngineEvent: (method) => engineEvents.push(method),
    });

    await submitCodexResidentRound({
      appSessionId: 'app-5',
      input: [{ type: 'text', text: 'hello' }],
      onEvent: (method) => roundEvents.push(method),
      onRequest: () => undefined,
    });

    // The engine starts a report of its own while the input is still queued.
    notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'engine-turn', status: 'inProgress' } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(roundEvents, []);
    assert.deepEqual(engineEvents, ['turn/started']);
  } finally {
    closeCodexResidentSessions();
  }
});

test('stopping a running round interrupts it and stopping a queued round drops the queue item', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-6',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    await submitCodexResidentRound({
      appSessionId: 'app-6',
      input: [{ type: 'text', text: 'hello' }],
      onEvent: () => {},
      onRequest: () => undefined,
    });

    assert.equal(await stopCodexResidentRound('app-6'), 'cancelled');
    assert.ok(server.calls.some((call) => call.method === 'thread/queue/delete'));
    assert.equal(server.queue.size, 0);

    await submitCodexResidentRound({
      appSessionId: 'app-6',
      input: [{ type: 'text', text: 'hello again' }],
      onEvent: () => {},
      onRequest: () => undefined,
    });
    drainQueue(server, 'turn-2');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(await stopCodexResidentRound('app-6'), 'interrupted');
    const interrupt = server.calls.find((call) => call.method === 'turn/interrupt');
    assert.equal(interrupt?.params.turnId, 'turn-2');
  } finally {
    closeCodexResidentSessions();
  }
});

test('the process stays alive after a round ends', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-7',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    await submitCodexResidentRound({
      appSessionId: 'app-7',
      input: [{ type: 'text', text: 'hello' }],
      onEvent: () => {},
      onRequest: () => undefined,
    });
    drainQueue(server, 'turn-3');
    await new Promise((resolve) => setTimeout(resolve, 20));

    completeCodexResidentRound('app-7');

    assert.equal(server.closed, false);
    assert.equal(listCodexResidentSessions().length, 1);
  } finally {
    closeCodexResidentSessions();
  }
});

test('the resident process asks for the experimental protocol it needs', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-8',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    assert.equal((server.openOptions as { experimentalApi?: boolean })?.experimentalApi, true);
  } finally {
    closeCodexResidentSessions();
  }
});

test('the oldest idle session is evicted when the resident limit is reached', async (t) => {
  const server = installFakeAppServer(t);
  process.env.CLOUDCLI_CODEX_RESIDENT_MAX = '2';
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-limit-1',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    await acquireCodexResidentSession({
      appSessionId: 'app-limit-2',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    await acquireCodexResidentSession({
      appSessionId: 'app-limit-3',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    const open = listCodexResidentSessions().map((session) => session.appSessionId).sort();
    assert.deepEqual(open, ['app-limit-2', 'app-limit-3']);
  } finally {
    delete process.env.CLOUDCLI_CODEX_RESIDENT_MAX;
    closeCodexResidentSessions();
  }
});

test('a session that still has work is not evicted for capacity', async (t) => {
  const server = installFakeAppServer(t);
  process.env.CLOUDCLI_CODEX_RESIDENT_MAX = '1';
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-busy',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      isBusy: () => true,
    });

    await assert.rejects(
      () => acquireCodexResidentSession({
        appSessionId: 'app-new',
        nativeThreadId: null,
        workingDirectory: '/tmp',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      }),
      /already keeping 1 conversations alive/,
    );
    assert.equal(listCodexResidentSessions().length, 1);
  } finally {
    delete process.env.CLOUDCLI_CODEX_RESIDENT_MAX;
    closeCodexResidentSessions();
  }
});

test('an idle session is reclaimed after the idle window', async (t) => {
  const server = installFakeAppServer(t);
  process.env.CLOUDCLI_CODEX_RESIDENT_IDLE_MS = '30';
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-idle',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    assert.equal(listCodexResidentSessions().length, 1);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(listCodexResidentSessions().length, 0);
    assert.equal(server.closed, true);
  } finally {
    delete process.env.CLOUDCLI_CODEX_RESIDENT_IDLE_MS;
    closeCodexResidentSessions();
  }
});

test('an engine turn that starts while the round waits does not take the round over', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-race',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    const roundEvents: string[] = [];
    const engineEvents: string[] = [];
    await acquireCodexResidentSession({
      appSessionId: 'app-race',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEngineEvent: (method) => engineEvents.push(method),
    });
    await submitCodexResidentRound({
      appSessionId: 'app-race',
      input: [{ type: 'text', text: 'hello' }],
      onEvent: (method) => roundEvents.push(method),
      onRequest: () => undefined,
    });

    // The engine starts a report of its own while the input is still queued.
    server.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'engine-turn', status: 'inProgress' },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(roundEvents.length, 0, 'the engine turn must not become the round');
    assert.ok(engineEvents.includes('turn/started'));

    // The input is consumed afterwards, and the turn that follows is the
    // round's own.
    server.queue.clear();
    server.handlers.onNotification?.('thread/queue/changed', { threadId: THREAD_ID } as any);
    server.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'round-turn', status: 'inProgress' },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(roundEvents.includes('turn/started'), 'the round must own the turn that follows');
    assert.equal(engineEvents.filter((method) => method === 'turn/started').length, 1);
  } finally {
    closeCodexResidentSessions();
  }
});

test('a queue that cannot be read ends the round as unknown instead of waiting forever', async (t) => {
  const server = installFakeAppServer(t);
  const original = server.queue;
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-unreadable',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    const ended: string[] = [];
    await acquireCodexResidentSession({
      appSessionId: 'app-unreadable',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onRoundEnded: (reason) => ended.push(reason),
    });
    await submitCodexResidentRound({
      appSessionId: 'app-unreadable',
      input: [{ type: 'text', text: 'hello' }],
      onEvent: () => {},
      onRequest: () => undefined,
    });

    // The queue cannot be read, so the round's turn cannot be identified.
    server.queue = { size: 0, values: () => { throw new Error('the queue is gone'); } } as never;
    server.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'unknown-turn', status: 'inProgress' },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepEqual(ended, ['unknown']);
  } finally {
    server.queue = original;
    closeCodexResidentSessions();
  }
});

test('withdrawing a queued input ends the round, because no turn will report it', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-withdrawn',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    const ended: string[] = [];
    await acquireCodexResidentSession({
      appSessionId: 'app-withdrawn',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onRoundEnded: (reason) => ended.push(reason),
    });
    await submitCodexResidentRound({
      appSessionId: 'app-withdrawn',
      input: [{ type: 'text', text: 'hello' }],
      onEvent: () => {},
      onRequest: () => undefined,
    });

    assert.equal(await stopCodexResidentRound('app-withdrawn'), 'cancelled');
    assert.deepEqual(ended, ['cancelled']);
  } finally {
    closeCodexResidentSessions();
  }
});

test('a report the engine is still running keeps the session busy', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-report',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    await submitCodexResidentRound({
      appSessionId: 'app-report',
      input: [{ type: 'text', text: 'hello' }],
      onEvent: () => {},
      onRequest: () => undefined,
    });
    completeCodexResidentRound('app-report');

    // The engine starts a report of its own and the round is over.
    server.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'report-turn', status: 'inProgress' },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(isCodexResidentSessionBusy('app-report'), true);
    server.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'report-turn', status: 'completed', error: null },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(isCodexResidentSessionBusy('app-report'), false);
  } finally {
    closeCodexResidentSessions();
  }
});

test('a changed native thread replaces the resident process', async (t) => {
  const server = installFakeAppServer(t);
  try {
    const first = await acquireCodexResidentSession({
      appSessionId: 'app-reforked',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    assert.equal(first.threadId, THREAD_ID);

    const second = await acquireCodexResidentSession({
      appSessionId: 'app-reforked',
      nativeThreadId: 'thread-after-edit',
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    assert.notEqual(second.generation, first.generation);
    assert.equal(server.closed, true, 'the old process must be closed');
    assert.ok(server.calls.some((call) => call.method === 'thread/resume' && call.params.threadId === 'thread-after-edit'));
  } finally {
    closeCodexResidentSessions();
  }
});

test('reusing a process keeps the credential it carried, and closing it revokes it', async (t) => {
  const server = installFakeAppServer(t);
  const revoked: string[] = [];
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-credential-reuse',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      env: () => ({ env: {}, credentialToken: 'tbc_first' }),
      revokeCredential: (token) => revoked.push(token),
    });

    // A later round borrows the same process. It must not take over the
    // revocation of the credential the process already carries.
    await acquireCodexResidentSession({
      appSessionId: 'app-credential-reuse',
      nativeThreadId: THREAD_ID,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      env: () => ({ env: {}, credentialToken: 'tbc_second' }),
      revokeCredential: (token) => revoked.push(token),
    });

    closeCodexResidentSessions();
    assert.deepEqual(revoked, ['tbc_first'], 'the credential the process carried must be revoked');
  } finally {
    closeCodexResidentSessions();
  }
});

test('the credential the process carried is revoked when the process is closed', async (t) => {
  const server = installFakeAppServer(t);
  const revoked: string[] = [];
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-credential',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      env: () => ({ env: {}, credentialToken: 'tbc_probe' }),
      revokeCredential: (token) => revoked.push(token),
    });

    assert.deepEqual(revoked, [], 'the credential lives as long as the process');
    closeCodexResidentSessions();
    assert.deepEqual(revoked, ['tbc_probe'], 'the credential dies with the process');
  } finally {
    closeCodexResidentSessions();
  }
});

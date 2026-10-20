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
  releaseCodexResidentSession,
  stopCodexResidentRound,
  submitCodexResidentRound,
} from '@/modules/providers/list/codex/codex-session-manager.js';

const THREAD_ID = '01a0c4d2-a3c3-7510-8e3f-c36245fa5d9d';

type FakeServer = {
  /** Resolves when the fake process is gone. */
  exited: Promise<void>;
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
  const server: FakeServer = {
    calls: [],
    handlers: {},
    closed: false,
    queue: new Map(),
    exited: Promise.resolve(),
  };

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
              return { deleted: true };
            }
          }
          return { deleted: false };
        }
        return {};
      },
      close() { server.closed = true; },
      waitForExit: () => server.exited,
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

for (const failureAt of ['open', 'config', 'thread'] as const) {
  test(`initialization failure at ${failureAt} releases the process and its credential`, async (t) => {
    let closed = 0;
    const revoked: string[] = [];
    t.mock.method(codexAppServerTransport, 'open', async () => {
      if (failureAt === 'open') throw new Error('initialization rejected');
      return {
        call: async () => { throw new Error('initialization rejected'); },
        close: () => { closed += 1; },
      };
    });
    await assert.rejects(acquireCodexResidentSession({
      appSessionId: `failed-${failureAt}`, nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      env: () => ({ env: {}, credentialToken: 'credential-to-revoke' }),
      config: async () => {
        if (failureAt === 'config') throw new Error('initialization rejected');
        return {};
      },
      revokeCredential: (token) => revoked.push(token),
    }), /initialization rejected/);
    closeCodexResidentSessions();
    assert.deepEqual(revoked, ['credential-to-revoke']);
    assert.equal(closed, failureAt === 'open' ? 0 : 1);
    assert.deepEqual(listCodexResidentSessions(), []);
  });
}

for (const blockedAt of ['open', 'thread'] as const) {
  test(`closing a session during ${blockedAt} cannot resurrect its process`, async (t) => {
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    let closed = 0;
    t.mock.method(codexAppServerTransport, 'open', async () => {
      if (blockedAt === 'open') { reached(); await blocked; }
      return {
        call: async () => {
          if (blockedAt === 'thread') { reached(); await blocked; }
          return { thread: { id: THREAD_ID } };
        },
        close: () => { closed += 1; },
      };
    });
    const opening = acquireCodexResidentSession({
      appSessionId: 'closing-initialization', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    await waiting;
    const busyWhileOpening = isCodexResidentSessionBusy('closing-initialization');
    closeCodexResidentSessions();
    resume();
    await assert.rejects(opening, /closed/);
    assert.equal(busyWhileOpening, true);
    assert.equal(closed, 1);
    assert.deepEqual(listCodexResidentSessions(), []);
  });
}

for (const reclaim of ['capacity', 'idle'] as const) {
  test(`an engine report is protected from ${reclaim} reclamation`, async (t) => {
    const server = installFakeAppServer(t);
    const previousEnv = { ...process.env };
    t.after(() => { process.env = previousEnv; });
    process.env.CLOUDCLI_CODEX_RESIDENT_MAX = '1';
    process.env.CLOUDCLI_CODEX_RESIDENT_IDLE_MS = '20';
    const options = {
      appSessionId: 'report-reclamation', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write' as const,
      sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
    };
    try {
      await acquireCodexResidentSession(options);
      notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'report-active' } });
      if (reclaim === 'capacity') {
        await assert.rejects(acquireCodexResidentSession({ ...options, appSessionId: 'another-session' }), /already keeping/);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(server.closed, false);
      assert.equal(isCodexResidentSessionBusy(options.appSessionId), true);
      notify(server, 'turn/completed', { threadId: THREAD_ID, turn: { id: 'report-active', status: 'completed' } });
      assert.equal(isCodexResidentSessionBusy(options.appSessionId), false);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(server.closed, true);
    } finally { closeCodexResidentSessions(); }
  });
}

test('a buffered report terminal event releases its activity registration', async (t) => {
  const server = installFakeAppServer(t);
  const events: string[] = [];
  try {
    await acquireCodexResidentSession({
      appSessionId: 'buffered-report', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEngineEvent: (method) => events.push(method),
    });
    await submitCodexResidentRound({ appSessionId: 'buffered-report', input: [], onEvent: () => {}, onRequest: () => {} });
    notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'buffered-engine' } });
    notify(server, 'turn/completed', { threadId: THREAD_ID, turn: { id: 'buffered-engine', status: 'completed' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    completeCodexResidentRound('buffered-report');
    assert.deepEqual(events, ['turn/started', 'turn/completed']);
    assert.equal(isCodexResidentSessionBusy('buffered-report'), false);
  } finally { closeCodexResidentSessions(); }
});

test('an unanswered session approval prevents reclamation until it is answered', async (t) => {
  const server = installFakeAppServer(t);
  const previousEnv = { ...process.env };
  t.after(() => { process.env = previousEnv; });
  process.env.CLOUDCLI_CODEX_RESIDENT_IDLE_MS = '20';
  let answer!: (value: unknown) => void;
  const approval = new Promise((resolve) => { answer = resolve; });
  try {
    await acquireCodexResidentSession({
      appSessionId: 'pending-session-approval', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'on-request', sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onSessionRequest: () => approval,
    });
    const request = server.handlers.onRequest?.('item/commandExecution/requestApproval', { threadId: THREAD_ID });
    const busy = isCodexResidentSessionBusy('pending-session-approval');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const closedWhileWaiting = server.closed;
    answer({ decision: 'decline' });
    await request;
    assert.equal(busy, true);
    assert.equal(closedWhileWaiting, false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(server.closed, true);
  } finally { answer?.({ decision: 'decline' }); closeCodexResidentSessions(); }
});

test('a rejected queue withdrawal is unknown and force-closes its process', async (t) => {
  const server = installFakeAppServer(t);
  let ended: string | null = null;
  try {
    const resident = await acquireCodexResidentSession({
      appSessionId: 'failed-withdrawal', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onRoundEnded: (reason) => { ended = reason; },
    });
    await submitCodexResidentRound({ appSessionId: 'failed-withdrawal', input: [], onEvent: () => {}, onRequest: () => {} });
    const call = resident.connection.call.bind(resident.connection);
    t.mock.method(resident.connection, 'call', async (method: string, params: unknown) => {
      if (method === 'thread/queue/delete') throw new Error('withdrawal rejected');
      return call(method, params);
    });
    assert.equal(await stopCodexResidentRound('failed-withdrawal'), 'unknown');
    assert.equal(ended, 'unknown');
    assert.equal(server.closed, true);
    assert.equal(listCodexResidentSessions().length, 0);
  } finally { closeCodexResidentSessions(); }
});

test('stopping during queue submission waits for the queue item before withdrawing it', async (t) => {
  const server = installFakeAppServer(t);
  try {
    const resident = await acquireCodexResidentSession({
      appSessionId: 'stop-submitting', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalCall = resident.connection.call.bind(resident.connection);
    t.mock.method(resident.connection, 'call', async (method: string, params: unknown) => {
      if (method === 'thread/queue/add') await gate;
      return originalCall(method, params);
    });
    const submitting = submitCodexResidentRound({ appSessionId: 'stop-submitting', input: [], onEvent: () => {}, onRequest: () => {} });
    const stopping = stopCodexResidentRound('stop-submitting');
    release();
    await submitting;
    assert.equal(await stopping, 'cancelled');
    assert.equal(server.queue.size, 0);
  } finally { closeCodexResidentSessions(); }
});

test('recreating a disposed conversation never reuses its process generation', async (t) => {
  installFakeAppServer(t);
  const options = {
    appSessionId: 'generation-after-disposal', nativeThreadId: null, workingDirectory: '/tmp',
    approvalPolicy: 'never', sandbox: 'workspace-write' as const,
    sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
  };
  try {
    const first = await acquireCodexResidentSession(options);
    closeCodexResidentSessions();
    const next = await acquireCodexResidentSession(options);
    assert.notEqual(next.generation, first.generation);
  } finally { closeCodexResidentSessions(); }
});

test('a queue item already consumed by the engine is not reported as withdrawn', async (t) => {
  const server = installFakeAppServer(t);
  let ended: string | null = null;
  try {
    const resident = await acquireCodexResidentSession({
      appSessionId: 'consumed-withdrawal', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onRoundEnded: (reason) => { ended = reason; },
    });
    await submitCodexResidentRound({ appSessionId: 'consumed-withdrawal', input: [], onEvent: () => {}, onRequest: () => {} });
    const original = resident.connection.call.bind(resident.connection);
    t.mock.method(resident.connection, 'call', async (method: string, params: unknown) => {
      if (method === 'thread/queue/delete') { server.queue.clear(); return { deleted: false }; }
      return original(method, params);
    });
    assert.equal(await stopCodexResidentRound('consumed-withdrawal'), 'unknown');
    assert.equal(ended, 'unknown');
    assert.equal(server.closed, true);
  } finally { closeCodexResidentSessions(); }
});

test('a native event callback failure only closes its owning conversation', async (t) => {
  const server = installFakeAppServer(t);
  const exits: string[] = [];
  try {
    await acquireCodexResidentSession({
      appSessionId: 'invalid-engine-call', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEngineEvent: () => { throw new Error('engine call snapshot conflicts'); },
      onSessionExit: (reason) => exits.push(reason),
    });
    assert.doesNotThrow(() => notify(server, 'item/started', { threadId: THREAD_ID, turnId: 'engine-turn' }));
    assert.equal(server.closed, true);
    assert.match(exits[0], /snapshot conflicts/);
    assert.equal(listCodexResidentSessions().length, 0);
  } finally { closeCodexResidentSessions(); }
});

test('out-of-order queue reads cannot give an older report the user turn', async (t) => {
  const server = installFakeAppServer(t);
  const owned: string[] = [];
  const reports: string[] = [];
  try {
    const resident = await acquireCodexResidentSession({
      appSessionId: 'reordered-reads', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEngineEvent: (_method, params) => reports.push(params.turn?.id),
    });
    await submitCodexResidentRound({ appSessionId: 'reordered-reads', input: [], onEvent: (_method, params) => owned.push(params.turn?.id), onRequest: () => {} });
    const original = resident.connection.call.bind(resident.connection);
    const reads: Array<(value: unknown) => void> = [];
    t.mock.method(resident.connection, 'call', (method: string, params: unknown) => {
      if (method === 'thread/queue/list') return new Promise((resolve) => reads.push(resolve));
      return original(method, params);
    });
    notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'older-report' } });
    notify(server, 'turn/completed', { threadId: THREAD_ID, turn: { id: 'older-report' } });
    server.queue.clear();
    notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'actual-user-turn' } });
    reads[1]({ data: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    reads[0]({ data: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(owned, ['actual-user-turn']);
    assert.deepEqual(reports, ['older-report', 'older-report']);
  } finally { closeCodexResidentSessions(); }
});

test('an old process completion cannot release a replacement round', async (t) => {
  installFakeAppServer(t);
  const options = {
    appSessionId: 'stale-completion', nativeThreadId: null, workingDirectory: '/tmp',
    approvalPolicy: 'never', sandbox: 'workspace-write' as const, sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
  };
  try {
    const old = await acquireCodexResidentSession(options);
    closeCodexResidentSessions();
    await acquireCodexResidentSession(options);
    await submitCodexResidentRound({ appSessionId: options.appSessionId, input: [], onEvent: () => {}, onRequest: () => {} });
    completeCodexResidentRound(options.appSessionId, { generation: old.generation, clientUserMessageId: 'old-round' });
    assert.equal(isCodexResidentSessionBusy(options.appSessionId), true);
  } finally { closeCodexResidentSessions(); }
});

test('a tool-result borrow replaces an idle process and resumes its native thread', async (t) => {
  const server = installFakeAppServer(t);
  const options = {
    appSessionId: 'one-shot-result', nativeThreadId: null, workingDirectory: '/tmp',
    approvalPolicy: 'never', sandbox: 'workspace-write' as const,
    sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
  };
  try {
    const first = await acquireCodexResidentSession(options);
    const continuation = await acquireCodexResidentSession({ ...options, lifetime: 'turn' });
    assert.notEqual(continuation.generation, first.generation);
    assert.equal(continuation.threadId, first.threadId);
    assert.equal(server.closed, true, 'the idle process must be closed before the continuation opens');
    assert.ok(server.calls.some((call) => call.method === 'thread/resume' && call.params.threadId === first.threadId));
    assert.equal(isCodexResidentSessionBusy(options.appSessionId), true, 'the one-shot process is reserved until release');
    await assert.rejects(acquireCodexResidentSession(options), { code: 'CODEX_SESSION_BUSY' });
  } finally { closeCodexResidentSessions(); }
});

test('a tool-result borrow leaves a reporting process alive and returns busy', async (t) => {
  const server = installFakeAppServer(t);
  const options = {
    appSessionId: 'busy-result', nativeThreadId: null, workingDirectory: '/tmp',
    approvalPolicy: 'never', sandbox: 'workspace-write' as const,
    sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
  };
  try {
    await acquireCodexResidentSession(options);
    notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'report-busy' } });
    await assert.rejects(acquireCodexResidentSession({ ...options, lifetime: 'turn' }), { code: 'CODEX_SESSION_BUSY' });
    assert.equal(server.closed, false);
    assert.equal(server.calls.filter((call) => call.method === 'thread/start' || call.method === 'thread/resume').length, 1);
  } finally { closeCodexResidentSessions(); }
});

test('a runtime round reservation protects input preparation from a tool-result borrow', async (t) => {
  const server = installFakeAppServer(t);
  const options = {
    appSessionId: 'preparing-round', nativeThreadId: null, workingDirectory: '/tmp',
    approvalPolicy: 'never', sandbox: 'workspace-write' as const, sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
  };
  try {
    const resident = await acquireCodexResidentSession({ ...options, reserveForRound: true });
    await assert.rejects(acquireCodexResidentSession({ ...options, lifetime: 'turn' }), { code: 'CODEX_SESSION_BUSY' });
    assert.equal(server.closed, false);
    assert.equal(listCodexResidentSessions()[0].generation, resident.generation);
  } finally { closeCodexResidentSessions(); }
});

test('a stale borrowed generation cannot submit into a replacement process', async (t) => {
  installFakeAppServer(t);
  const options = {
    appSessionId: 'stale-submit', nativeThreadId: null, workingDirectory: '/tmp',
    approvalPolicy: 'never', sandbox: 'workspace-write' as const, sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
  };
  try {
    const old = await acquireCodexResidentSession(options);
    closeCodexResidentSessions();
    const next = await acquireCodexResidentSession(options);
    await assert.rejects(submitCodexResidentRound({
      appSessionId: options.appSessionId, generation: old.generation, input: [], onEvent() {}, onRequest() {},
    }), /generation|replaced/i);
    assert.equal(listCodexResidentSessions()[0].generation, next.generation);
  } finally { closeCodexResidentSessions(); }
});

for (const failure of ['rejected', 'no-terminal'] as const) {
  test(`a running stop ${failure} cannot leave its process working indefinitely`, async (t) => {
    const server = installFakeAppServer(t);
    let ended: string | null = null;
    try {
      const resident = await acquireCodexResidentSession({
        appSessionId: `running-stop-${failure}`, nativeThreadId: null, workingDirectory: '/tmp',
        approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
        onRoundEnded: (reason) => { ended = reason; },
      });
      await submitCodexResidentRound({ appSessionId: resident.appSessionId, input: [], onEvent() {}, onRequest() {} });
      drainQueue(server, 'turn-to-stop');
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (failure === 'rejected') {
        const original = resident.connection.call.bind(resident.connection);
        t.mock.method(resident.connection, 'call', async (method: string, params: unknown) => {
          if (method === 'turn/interrupt') throw new Error('interrupt rejected');
          return original(method, params);
        });
        assert.equal(await stopCodexResidentRound(resident.appSessionId), 'unknown');
      } else {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        assert.equal(await stopCodexResidentRound(resident.appSessionId), 'interrupted');
        t.mock.timers.tick(3_001);
      }
      assert.equal(ended, 'unknown');
      assert.equal(server.closed, true);
    } finally { closeCodexResidentSessions(); }
  });
}

test('withdrawing queued input preserves a report buffered while its ownership was checked', async (t) => {
  const server = installFakeAppServer(t);
  const reports: string[] = [];
  let releaseRead!: (value: unknown) => void;
  try {
    const resident = await acquireCodexResidentSession({
      appSessionId: 'withdraw-with-report', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEngineEvent: (method) => reports.push(method),
    });
    await submitCodexResidentRound({ appSessionId: resident.appSessionId, input: [], onEvent() {}, onRequest() {} });
    const original = resident.connection.call.bind(resident.connection);
    t.mock.method(resident.connection, 'call', (method: string, params: unknown) => {
      if (method === 'thread/queue/list') return new Promise((resolve) => { releaseRead = resolve; });
      return original(method, params);
    });
    notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'report-during-withdrawal' } });
    assert.equal(await stopCodexResidentRound(resident.appSessionId), 'cancelled');
    assert.deepEqual(reports, ['turn/started']);
    assert.equal(isCodexResidentSessionBusy(resident.appSessionId), true);
    notify(server, 'turn/completed', { threadId: THREAD_ID, turn: { id: 'report-during-withdrawal' } });
    assert.equal(isCodexResidentSessionBusy(resident.appSessionId), false);
  } finally {
    releaseRead?.({ data: [] });
    closeCodexResidentSessions();
  }
});

test('a confirmed stop cancels its shared watchdog before a later round', async (t) => {
  const server = installFakeAppServer(t);
  try {
    const resident = await acquireCodexResidentSession({
      appSessionId: 'stop-watchdog-scope', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    const submit = () => submitCodexResidentRound({ appSessionId: resident.appSessionId, input: [], onEvent() {}, onRequest() {} });
    await submit();
    drainQueue(server, 'first-watchdog-turn');
    await new Promise((resolve) => setTimeout(resolve, 10));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const firstStop = stopCodexResidentRound(resident.appSessionId);
    const repeatedStop = stopCodexResidentRound(resident.appSessionId);
    assert.equal(firstStop, repeatedStop);
    await firstStop;
    assert.equal(server.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
    notify(server, 'turn/completed', { threadId: THREAD_ID, turn: { id: 'first-watchdog-turn' } });
    completeCodexResidentRound(resident.appSessionId);
    await submit();
    t.mock.timers.tick(10_000);
    assert.equal(server.closed, false);
    assert.equal(isCodexResidentSessionBusy(resident.appSessionId), true);
  } finally { closeCodexResidentSessions(); }
});

test('an approval of a report does not belong to the user round waiting in the queue', async (t) => {
  const server = installFakeAppServer(t);
  try {
    const resident = await acquireCodexResidentSession({
      appSessionId: 'approval-owner', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onSessionRequest: () => ({ owner: 'session' }),
    });
    await submitCodexResidentRound({ appSessionId: resident.appSessionId, input: [], onEvent() {}, onRequest: () => ({ owner: 'round' }) });
    notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'asking-report' } });
    assert.deepEqual(await server.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID, turnId: 'asking-report', itemId: 'report-command',
    }), { owner: 'session' });
    notify(server, 'turn/completed', { threadId: THREAD_ID, turn: { id: 'asking-report' } });
    drainQueue(server, 'asking-user-turn');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await server.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID, turnId: 'asking-user-turn', itemId: 'user-command',
    }), { owner: 'round' });
  } finally { closeCodexResidentSessions(); }
});

test('a second runtime reservation cannot replace an active user round callbacks', async (t) => {
  installFakeAppServer(t);
  const options = {
    appSessionId: 'duplicate-runtime-borrow', nativeThreadId: null, workingDirectory: '/tmp', reserveForRound: true,
    approvalPolicy: 'never', sandbox: 'workspace-write' as const, sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
  };
  try {
    const resident = await acquireCodexResidentSession(options);
    await submitCodexResidentRound({ appSessionId: resident.appSessionId, input: [], onEvent() {}, onRequest() {} });
    await assert.rejects(acquireCodexResidentSession(options), { code: 'CODEX_SESSION_BUSY' });
    assert.equal(isCodexResidentSessionBusy(resident.appSessionId), true);
  } finally { closeCodexResidentSessions(); }
});

test('an approval waits for its pending turn ownership before choosing the audience', async (t) => {
  const server = installFakeAppServer(t);
  let releaseRead!: (value: unknown) => void;
  try {
    const resident = await acquireCodexResidentSession({
      appSessionId: 'pending-approval-owner', nativeThreadId: null, workingDirectory: '/tmp',
      approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onSessionRequest: () => ({ owner: 'session' }),
    });
    await submitCodexResidentRound({ appSessionId: resident.appSessionId, input: [], onEvent() {}, onRequest: () => ({ owner: 'round' }) });
    const original = resident.connection.call.bind(resident.connection);
    t.mock.method(resident.connection, 'call', (method: string, params: unknown) => {
      if (method === 'thread/queue/list') return new Promise((resolve) => { releaseRead = resolve; });
      return original(method, params);
    });
    server.queue.clear();
    notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'pending-own-turn' } });
    let settled = false;
    const request = Promise.resolve(server.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID, turnId: 'pending-own-turn', itemId: 'pending-own-command',
    })).then((result) => { settled = true; return result; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const prematurelySettled = settled;
    releaseRead({ data: [] });
    assert.deepEqual(await request, { owner: 'round' });
    assert.equal(prematurelySettled, false);
  } finally { releaseRead?.({ data: [] }); closeCodexResidentSessions(); }
});

test('a process that held the thread is gone before the next one resumes it', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-handover',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    // The engine allows one writer per thread, so the next process has to wait
    // for this one to release it.
    let release = () => {};
    server.exited = new Promise<void>((resolve) => { release = resolve; });
    releaseCodexResidentSession('app-handover', { dispose: true });

    let resumed = false;
    const handover = acquireCodexResidentSession({
      appSessionId: 'app-handover',
      nativeThreadId: 'thread-after-release',
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    }).then(() => { resumed = true; });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resumed, false, 'the new process must wait for the old one');

    release();
    await handover;
    assert.equal(resumed, true);
  } finally {
    closeCodexResidentSessions();
  }
});

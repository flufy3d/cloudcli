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
  borrowCodexAuxiliaryThread,
  closeCodexResidentSessionAdmission,
  closeCodexResidentSessions,
  completeCodexResidentRound,
  isCodexResidentSessionBusy,
  readCodexResidentSessionActivity,
  listCodexResidentSessions,
  listCodexReportingOnlySessions,
  openCodexResidentSessionAdmission,
  releaseCodexResidentSession,
  stopCodexResidentRound,
  submitCodexResidentRound,
} from '@/modules/providers/list/codex/codex-session-manager.js';

const THREAD_ID = '01a0c4d2-a3c3-7510-8e3f-c36245fa5d9d';
const AUX_THREAD_ID = '01a0c4d2-a3c3-7510-8e3f-c36245fa5e11';

type FakeServer = {
  /** Resolves when the fake process is gone. */
  exited: Promise<void>;
  calls: Array<{ method: string; params: any; options?: { timeoutMs?: number } }>;
  handlers: CodexAppServerHandlers;
  closed: boolean;
  openOptions?: unknown;
  auxStart?: () => Promise<unknown>;
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
      async call(method: string, params: any, options?: { timeoutMs?: number }) {
        server.calls.push({ method, params, options });
        if (method === 'thread/start' && params.ephemeral === true) {
          if (server.auxStart) return server.auxStart();
          // An auxiliary thread starts ephemeral on the same process; the
          // engine persists nothing and hands back a fresh thread id.
          return { thread: { id: AUX_THREAD_ID }, sandbox: { type: 'readOnly' }, activePermissionProfile: { id: ':read-only' } };
        }
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

test('the session says whether its round waits for the engine', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-activity',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    // The session is resident but has no round, so nothing waits for the
    // engine.
    let activity = readCodexResidentSessionActivity('app-activity');
    assert.equal(activity?.queued, false);
    assert.equal(activity?.reporting, false);

    await submitCodexResidentRound({
      appSessionId: 'app-activity',
      input: [{ type: 'text', text: 'hello' }],
      onEvent: () => {},
      onRequest: () => undefined,
    });

    // The input is in the engine's queue; the engine has not started a turn
    // for it yet.
    activity = readCodexResidentSessionActivity('app-activity');
    assert.equal(activity?.queued, true);
    assert.equal(activity?.reporting, false);

    // The engine starts the round's turn: the round is no longer waiting.
    drainQueue(server, 'activity-turn');
    await new Promise((resolve) => setTimeout(resolve, 30));
    activity = readCodexResidentSessionActivity('app-activity');
    assert.equal(activity?.queued, false);
  } finally {
    closeCodexResidentSessions();
  }
});

test('a report the engine runs on its own is reported as reporting', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession({
      appSessionId: 'app-report-activity',
      nativeThreadId: null,
      workingDirectory: '/tmp',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    server.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'report-turn', status: 'inProgress' },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(readCodexResidentSessionActivity('app-report-activity')?.reporting, true);
    // No agent is left to list the session by, so the report itself does: else
    // the page shows the conversation idle while the engine writes to it.
    assert.deepEqual(listCodexReportingOnlySessions(), ['app-report-activity']);

    server.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'report-turn', status: 'completed' },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(listCodexReportingOnlySessions(), []);
  } finally {
    closeCodexResidentSessions();
  }
});

// ----- Auxiliary (ephemeral) thread borrows -----

const residentOptions = (appSessionId: string) => ({
  appSessionId,
  nativeThreadId: null,
  workingDirectory: '/tmp',
  approvalPolicy: 'never',
  sandbox: 'workspace-write' as const,
  sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false },
});

/** What a title borrower asks for: an ephemeral, read-only thread on the same process. */
const AUXILIARY_START = { ephemeral: true, cwd: '/tmp', sandbox: 'read-only', threadSource: 'thread_title' };

test('an auxiliary borrow starts an ephemeral thread on the resident process and hands out no close', async (t) => {
  const server = installFakeAppServer(t);
  try {
    const resident = await acquireCodexResidentSession(residentOptions('app-aux'));
    const handle = await borrowCodexAuxiliaryThread({
      appSessionId: 'app-aux',
      generation: resident.generation,
      start: AUXILIARY_START,
      onNotification: () => {},
    });

    assert.equal(handle.threadId, AUX_THREAD_ID);
    assert.equal(handle.generation, resident.generation);
    assert.equal('close' in handle, false);
    // One process, two threads: the conversation's and the ephemeral one.
    assert.equal(listCodexResidentSessions().length, 1);
    const starts = server.calls.filter((call) => call.method === 'thread/start');
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1].params, AUXILIARY_START);

    handle.release();
    handle.release();
  } finally {
    closeCodexResidentSessions();
  }
});

test('the events and requests of an auxiliary thread reach only its borrower', async (t) => {
  const server = installFakeAppServer(t);
  const engineEvents: Array<{ method: string; threadId: string }> = [];
  const sessionRequests: string[] = [];
  const borrowerEvents: string[] = [];
  try {
    await acquireCodexResidentSession({
      ...residentOptions('app-aux-events'),
      onEngineEvent: (method, _params, threadId) => { engineEvents.push({ method, threadId }); },
      onSessionRequest: (method) => { sessionRequests.push(method); return { owner: 'session' }; },
    });
    await borrowCodexAuxiliaryThread({
      appSessionId: 'app-aux-events',
      start: AUXILIARY_START,
      onNotification: (method) => { borrowerEvents.push(method); },
      onRequest: () => ({ owner: 'borrower' }),
    });

    // The ephemeral thread's own announcement carries its id nested in the thread object.
    notify(server, 'thread/started', { thread: { id: AUX_THREAD_ID } });
    notify(server, 'turn/started', { threadId: AUX_THREAD_ID, turn: { id: 'aux-turn', status: 'inProgress' } });
    notify(server, 'item/completed', { threadId: AUX_THREAD_ID, turnId: 'aux-turn', item: { type: 'agentMessage', text: '{"title":"x"}' } });
    notify(server, 'turn/completed', { threadId: AUX_THREAD_ID, turn: { id: 'aux-turn', status: 'completed' } });
    assert.deepEqual(borrowerEvents, ['thread/started', 'turn/started', 'item/completed', 'turn/completed']);
    assert.deepEqual(engineEvents, []);
    // The borrower's turn is not engine work: the page must not show the conversation busy.
    assert.deepEqual(readCodexResidentSessionActivity('app-aux-events'), { queued: false, reporting: false });

    // The conversation's own thread keeps its audience.
    notify(server, 'turn/started', { threadId: THREAD_ID, turn: { id: 'engine-turn', status: 'inProgress' } });
    assert.deepEqual(engineEvents, [{ method: 'turn/started', threadId: THREAD_ID }]);
    assert.equal(borrowerEvents.length, 4);

    // A request from the ephemeral thread is answered by the borrower, never by the conversation.
    assert.deepEqual(
      await server.handlers.onRequest?.('item/commandExecution/requestApproval', { threadId: AUX_THREAD_ID } as any),
      { owner: 'borrower' },
    );
    assert.deepEqual(
      await server.handlers.onRequest?.('item/commandExecution/requestApproval', { threadId: THREAD_ID } as any),
      { owner: 'session' },
    );
    assert.deepEqual(sessionRequests, ['item/commandExecution/requestApproval']);
  } finally {
    closeCodexResidentSessions();
  }
});

test('a borrower without a request handler has the engine request refused, not forwarded', async (t) => {
  const server = installFakeAppServer(t);
  let sessionRequests = 0;
  try {
    await acquireCodexResidentSession({
      ...residentOptions('app-aux-refuse'),
      onSessionRequest: () => { sessionRequests += 1; return {}; },
    });
    await borrowCodexAuxiliaryThread({ appSessionId: 'app-aux-refuse', start: AUXILIARY_START, onNotification: () => {} });

    // `undefined` is what the client turns into a "method not supported" refusal.
    assert.equal(await server.handlers.onRequest?.('item/tool/requestUserInput', { threadId: AUX_THREAD_ID } as any), undefined);
    assert.equal(sessionRequests, 0);
  } finally {
    closeCodexResidentSessions();
  }
});

test('an auxiliary borrow keeps the session alive and lets it idle out once released', async (t) => {
  const server = installFakeAppServer(t);
  process.env.CLOUDCLI_CODEX_RESIDENT_IDLE_MS = '30';
  try {
    await acquireCodexResidentSession(residentOptions('app-aux-idle'));
    const handle = await borrowCodexAuxiliaryThread({ appSessionId: 'app-aux-idle', start: AUXILIARY_START, onNotification: () => {} });
    assert.equal(isCodexResidentSessionBusy('app-aux-idle'), true);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(listCodexResidentSessions().length, 1);
    assert.equal(server.closed, false);

    handle.release();
    assert.equal(isCodexResidentSessionBusy('app-aux-idle'), false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(listCodexResidentSessions(), []);
    assert.equal(server.closed, true);
  } finally {
    delete process.env.CLOUDCLI_CODEX_RESIDENT_IDLE_MS;
    closeCodexResidentSessions();
  }
});

test('an auxiliary borrow is refused when no resident conversation can lend a thread', async (t) => {
  const server = installFakeAppServer(t);
  const borrow = (appSessionId: string, extra: Record<string, unknown> = {}) => borrowCodexAuxiliaryThread({
    appSessionId,
    start: AUXILIARY_START,
    onNotification: () => {},
    ...extra,
  });
  try {
    await assert.rejects(borrow('app-aux-missing'), { code: 'CODEX_AUXILIARY_UNAVAILABLE' });

    const resident = await acquireCodexResidentSession(residentOptions('app-aux-gate'));
    await assert.rejects(borrow('app-aux-gate', { generation: resident.generation + 1 }), { code: 'CODEX_AUXILIARY_UNAVAILABLE' });

    closeCodexResidentSessionAdmission('app-aux-gate');
    await assert.rejects(borrow('app-aux-gate'), { code: 'CODEX_AUXILIARY_UNAVAILABLE' });
    openCodexResidentSessionAdmission('app-aux-gate');

    await assert.rejects(
      borrow('app-aux-gate', { start: { ...AUXILIARY_START, ephemeral: false } }),
      { code: 'CODEX_AUXILIARY_NOT_EPHEMERAL' },
    );
    // None of the refusals reached the engine.
    assert.equal(server.calls.filter((call) => call.method === 'thread/start').length, 1);

    // A one-shot tool-result process is exclusive to its turn.
    closeCodexResidentSessions();
    await acquireCodexResidentSession({ ...residentOptions('app-aux-oneshot'), lifetime: 'turn' });
    await assert.rejects(borrow('app-aux-oneshot'), { code: 'CODEX_AUXILIARY_UNAVAILABLE' });
  } finally {
    openCodexResidentSessionAdmission('app-aux-gate');
    closeCodexResidentSessions();
  }
});

test('losing the process tells the auxiliary borrower and dead-ends its handle', async (t) => {
  installFakeAppServer(t);
  const disposed: string[] = [];
  try {
    await acquireCodexResidentSession(residentOptions('app-aux-dispose'));
    const handle = await borrowCodexAuxiliaryThread({
      appSessionId: 'app-aux-dispose',
      start: AUXILIARY_START,
      onNotification: () => {},
      onDisposed: (reason) => { disposed.push(reason); },
    });

    closeCodexResidentSessions();

    assert.deepEqual(disposed, ['host shutdown']);
    await assert.rejects(handle.call('thread/read', { threadId: AUX_THREAD_ID }), { code: 'CODEX_AUXILIARY_UNAVAILABLE' });
    handle.release();
  } finally {
    closeCodexResidentSessions();
  }
});

test('a borrower that fails on disposal does not keep the process from closing', async (t) => {
  const server = installFakeAppServer(t);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  try {
    await acquireCodexResidentSession(residentOptions('app-aux-throw'));
    await borrowCodexAuxiliaryThread({
      appSessionId: 'app-aux-throw',
      start: AUXILIARY_START,
      onNotification: () => {},
      onDisposed: () => { throw new Error('borrower broke'); },
    });

    closeCodexResidentSessions();

    assert.equal(server.closed, true);
    assert.deepEqual(listCodexResidentSessions(), []);
    assert.ok(warnings.some((args) => String(args[0]).includes('auxiliary borrower')));
  } finally {
    closeCodexResidentSessions();
  }
});

test('an auxiliary handle reaches its own thread, the name of another, and nothing else', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession(residentOptions('app-aux-scope'));
    const handle = await borrowCodexAuxiliaryThread({ appSessionId: 'app-aux-scope', start: AUXILIARY_START, onNotification: () => {} });
    const callsBefore = server.calls.length;

    await handle.call('turn/start', { threadId: AUX_THREAD_ID, input: [] });
    await handle.call('turn/interrupt', { threadId: AUX_THREAD_ID, turnId: 'aux-turn' });
    await handle.call('thread/unsubscribe', { threadId: AUX_THREAD_ID });
    await handle.call('model/list', {});
    await handle.call('config/read', { includeLayers: false });
    await handle.call('thread/read', { threadId: THREAD_ID });
    await handle.call('thread/name/set', { threadId: THREAD_ID, name: 'Investigate duplicate replies' });
    assert.equal(server.calls.length - callsBefore, 7);

    for (const [method, params] of [
      ['thread/start', { ephemeral: true }],
      ['thread/resume', { threadId: THREAD_ID }],
      ['thread/fork', { threadId: THREAD_ID }],
      ['turn/start', { threadId: THREAD_ID, input: [] }],
      ['turn/interrupt', { threadId: THREAD_ID, turnId: 'user-turn' }],
      ['thread/queue/add', { threadId: THREAD_ID, input: [] }],
      ['thread/queue/delete', { threadId: THREAD_ID, queuedSubmissionId: 'q1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      await assert.rejects(handle.call(method, params), { code: 'CODEX_AUXILIARY_THREAD_SCOPE' });
    }
    assert.equal(server.calls.length - callsBefore, 7);
  } finally {
    closeCodexResidentSessions();
  }
});

test('an auxiliary borrow does not replace the callbacks of the conversation', async (t) => {
  const server = installFakeAppServer(t);
  const engineEvents: string[] = [];
  const exits: string[] = [];
  try {
    await acquireCodexResidentSession({
      ...residentOptions('app-aux-callbacks'),
      onEngineEvent: (method) => { engineEvents.push(method); },
      onSessionExit: (reason) => { exits.push(reason); },
    });
    await borrowCodexAuxiliaryThread({ appSessionId: 'app-aux-callbacks', start: AUXILIARY_START, onNotification: () => {} });

    // A thread this session never lent (a subagent) is still the conversation's engine work.
    notify(server, 'item/completed', { threadId: 'subagent-thread', item: { type: 'agentMessage' } });
    assert.deepEqual(engineEvents, ['item/completed']);

    server.handlers.onExit?.('crashed');
    assert.deepEqual(exits, ['crashed']);
  } finally {
    closeCodexResidentSessions();
  }
});


test('a starting auxiliary thread keeps its resident process busy until startup settles', async (t) => {
  const server = installFakeAppServer(t);
  let finish!: (result: unknown) => void;
  server.auxStart = () => new Promise((resolve) => { finish = resolve; });
  try {
    await acquireCodexResidentSession(residentOptions('aux-starting'));
    const pending = borrowCodexAuxiliaryThread({ appSessionId: 'aux-starting', start: AUXILIARY_START, onNotification: () => {} });
    assert.equal(isCodexResidentSessionBusy('aux-starting'), true);
    finish({ thread: { id: AUX_THREAD_ID } });
    const handle = await pending;
    assert.equal(isCodexResidentSessionBusy('aux-starting'), true);
    handle.release();
    assert.equal(isCodexResidentSessionBusy('aux-starting'), false);
  } finally {
    finish?.({ thread: { id: AUX_THREAD_ID } });
    closeCodexResidentSessions();
  }
});

test('a failing auxiliary notification cannot close or replace the conversation', async (t) => {
  const server = installFakeAppServer(t);
  const disposed: string[] = [];
  const chat: string[] = [];
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  try {
    await acquireCodexResidentSession({ ...residentOptions('aux-callback-failure'), onEngineEvent: (method) => chat.push(method) });
    const handle = await borrowCodexAuxiliaryThread({
      appSessionId: 'aux-callback-failure', start: AUXILIARY_START,
      onNotification: () => { throw new Error('invalid title response'); },
      onDisposed: (reason) => disposed.push(reason),
    });
    notify(server, 'item/completed', { threadId: AUX_THREAD_ID, item: {} });
    assert.equal(server.closed, false);
    assert.equal(listCodexResidentSessions().length, 1);
    assert.equal(disposed.length, 1);
    assert.ok(warnings.length > 0);
    notify(server, 'turn/completed', { threadId: AUX_THREAD_ID, turn: { id: 'aux-turn' } });
    assert.equal(disposed.length, 1);
    assert.deepEqual(chat, []);
    await handle.call('turn/interrupt', { threadId: AUX_THREAD_ID, turnId: 'aux-turn' });
    handle.release();
  } finally { closeCodexResidentSessions(); }
});

test('auxiliary calls refuse global mutations and missing or ambiguous thread targets', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession(residentOptions('aux-global-scope'));
    const handle = await borrowCodexAuxiliaryThread({ appSessionId: 'aux-global-scope', start: AUXILIARY_START, onNotification: () => {} });
    const before = server.calls.length;
    for (const [method, params] of [
      ['command/exec', { command: ['touch', '/tmp/forbidden'] }],
      ['config/value/write', { keyPath: 'sandbox_mode', value: 'danger-full-access' }],
      ['thread/archive', { threadId: AUX_THREAD_ID }],
      ['turn/start', {}],
      ['thread/name/set', { thread_id: THREAD_ID, name: 'bypass' }],
      ['turn/start', { threadId: AUX_THREAD_ID, thread_id: THREAD_ID }],
    ] as const) await assert.rejects(handle.call(method, params), { code: 'CODEX_AUXILIARY_THREAD_SCOPE' });
    assert.equal(server.calls.length, before);
    handle.release();
  } finally { closeCodexResidentSessions(); }
});


test('an auxiliary borrower receives the actual sandbox and permission profile', async (t) => {
  installFakeAppServer(t);
  try {
    await acquireCodexResidentSession(residentOptions('aux-permissions'));
    const handle = await borrowCodexAuxiliaryThread({ appSessionId: 'aux-permissions', start: AUXILIARY_START, onNotification: () => {} });
    assert.deepEqual(handle.startResult?.sandbox, { type: 'readOnly' });
    assert.deepEqual(handle.startResult?.activePermissionProfile, { id: ':read-only' });
    handle.release();
  } finally { closeCodexResidentSessions(); }
});

test('failed auxiliary startup releases its activity without releasing a concurrent startup', async (t) => {
  const server = installFakeAppServer(t);
  const pending: Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void }> = [];
  server.auxStart = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  try {
    await acquireCodexResidentSession(residentOptions('aux-concurrent-start'));
    const first = borrowCodexAuxiliaryThread({ appSessionId: 'aux-concurrent-start', start: AUXILIARY_START, onNotification: () => {} });
    const second = borrowCodexAuxiliaryThread({ appSessionId: 'aux-concurrent-start', start: AUXILIARY_START, onNotification: () => {} });
    const rejected = assert.rejects(first, /start refused/);
    pending[0].reject(new Error('start refused'));
    await rejected;
    assert.equal(isCodexResidentSessionBusy('aux-concurrent-start'), true);
    pending[1].resolve({ thread: { id: AUX_THREAD_ID } });
    const handle = await second;
    handle.release();
    assert.equal(isCodexResidentSessionBusy('aux-concurrent-start'), false);
    assert.equal(server.closed, false);
  } finally { closeCodexResidentSessions(); }
});

test('an auxiliary request handler failure is refused without terminating the conversation', async (t) => {
  const server = installFakeAppServer(t);
  const disposed: string[] = [];
  t.mock.method(console, 'warn', () => {});
  try {
    await acquireCodexResidentSession(residentOptions('aux-request-failure'));
    const handle = await borrowCodexAuxiliaryThread({
      appSessionId: 'aux-request-failure', start: AUXILIARY_START,
      onNotification: () => {}, onRequest: async () => { throw new Error('request failed'); },
      onDisposed: (reason) => disposed.push(reason),
    });
    const result = await server.handlers.onRequest?.('item/tool/requestUserInput', { threadId: AUX_THREAD_ID });
    assert.equal(result, undefined);
    assert.equal(server.closed, false);
    assert.deepEqual(disposed, ['auxiliary handler failed']);
    await handle.call('thread/unsubscribe', { threadId: AUX_THREAD_ID });
    handle.release();
    assert.equal(isCodexResidentSessionBusy('aux-request-failure'), false);
  } finally { closeCodexResidentSessions(); }
});


test('auxiliary startup forwards its deadline and invalid startup releases activity', async (t) => {
  const server = installFakeAppServer(t);
  try {
    await acquireCodexResidentSession(residentOptions('aux-invalid-start'));
    server.auxStart = async () => ({ thread: {} });
    await assert.rejects(borrowCodexAuxiliaryThread({
      appSessionId: 'aux-invalid-start', start: AUXILIARY_START, timeoutMs: 42, onNotification: () => {},
    }), { code: 'CODEX_AUXILIARY_UNAVAILABLE' });
    assert.equal(server.calls.at(-1)?.options?.timeoutMs, 42);
    assert.equal(isCodexResidentSessionBusy('aux-invalid-start'), false);
    server.auxStart = async () => ({ thread: { id: AUX_THREAD_ID } });
    const handle = await borrowCodexAuxiliaryThread({ appSessionId: 'aux-invalid-start', start: AUXILIARY_START, onNotification: () => {} });
    for (const params of [null, undefined, { threadId: 'unrelated' }, { threadId: '' }]) {
      await assert.rejects(handle.call('thread/read', params), { code: 'CODEX_AUXILIARY_THREAD_SCOPE' });
    }
    handle.release();
  } finally { closeCodexResidentSessions(); }
});


test('a late thread started after startup timeout is detached without touching the conversation', async (t) => {
  const server = installFakeAppServer(t);
  const chat: string[] = [];
  try {
    await acquireCodexResidentSession({ ...residentOptions('aux-late-start'), onEngineEvent: (method) => chat.push(method) });
    server.auxStart = async () => { throw new Error('startup timed out'); };
    await assert.rejects(borrowCodexAuxiliaryThread({
      appSessionId: 'aux-late-start', start: AUXILIARY_START, onNotification: () => {},
    }), /startup timed out/);
    notify(server, 'thread/started', { thread: { id: AUX_THREAD_ID, ephemeral: true, threadSource: 'thread_title' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(server.calls.some((call) => call.method === 'thread/unsubscribe' && call.params.threadId === AUX_THREAD_ID));
    assert.equal(server.closed, false);
    assert.equal(isCodexResidentSessionBusy('aux-late-start'), false);
    assert.deepEqual(chat, []);
  } finally { closeCodexResidentSessions(); }
});

test('startup announcements wait for concurrent ownership and never detach a successful borrower', async (t) => {
  const server = installFakeAppServer(t);
  const pending: Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void }> = [];
  server.auxStart = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  try {
    await acquireCodexResidentSession(residentOptions('aux-announcements'));
    const failed = borrowCodexAuxiliaryThread({ appSessionId: 'aux-announcements', start: AUXILIARY_START, onNotification: () => {} });
    const success = borrowCodexAuxiliaryThread({ appSessionId: 'aux-announcements', start: AUXILIARY_START, onNotification: () => {} });
    const failure = assert.rejects(failed, /timeout/);
    notify(server, 'thread/started', { thread: { id: 'orphan', ephemeral: true, threadSource: 'thread_title' } });
    notify(server, 'thread/started', { thread: { id: AUX_THREAD_ID, ephemeral: true, threadSource: 'thread_title' } });
    pending[0].reject(new Error('timeout'));
    await failure;
    assert.equal(server.calls.some((call) => call.method === 'thread/unsubscribe'), false);
    pending[1].resolve({ thread: { id: AUX_THREAD_ID } });
    const handle = await success;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(server.calls.filter((call) => call.method === 'thread/unsubscribe').map((call) => call.params.threadId), ['orphan']);
    assert.equal(isCodexResidentSessionBusy('aux-announcements'), true);
    handle.release();
    assert.equal(isCodexResidentSessionBusy('aux-announcements'), false);
  } finally { closeCodexResidentSessions(); }
});

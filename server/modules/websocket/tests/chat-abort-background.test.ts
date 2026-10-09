import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'background-abort-session';

async function withGateway(
  backgroundPending: boolean,
  runTest: (context: {
    socket: EventEmitter;
    frames: Array<Record<string, unknown>>;
    aborts: Array<{ provider: string; sessionId: string }>;
    createRun: (completed?: boolean) => void;
    onAbort: (action: () => void) => void;
  }) => Promise<void>,
  abortSuccess: boolean | Error = true,
) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chat-abort-background-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const frames: Array<Record<string, unknown>> = [];
  const aborts: Array<{ provider: string; sessionId: string }> = [];
  let abortAction: (() => void) | undefined;
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1, send: (data: string) => frames.push(JSON.parse(data)),
  });
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', directory);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasBackgroundWork: () => backgroundPending,
        abort: async (provider: string, sessionId: string) => {
          aborts.push({ provider, sessionId });
          abortAction?.();
          if (abortSuccess instanceof Error) throw abortSuccess;
          return abortSuccess;
        },
      } as never,
    });
    await runTest({
      socket, frames, aborts,
      onAbort: (action) => { abortAction = action; },
      createRun: (completed = true) => {
        const run = chatRunRegistry.startRun({
          appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: socket as never, userId: 1,
        });
        assert.ok(run);
        if (completed) run.writer.send({ kind: 'complete', provider: 'claude', sessionId: SESSION_ID, exitCode: 0 });
        frames.length = 0;
      },
    });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

for (const retainedRun of [false, true]) {
  test(`stops a pending background reply with retained run=${retainedRun}`, async () => {
    await withGateway(true, async ({ socket, frames, aborts, createRun }) => {
      if (retainedRun) createRun();
      socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
      await settle();
      assert.deepEqual(aborts, [{ provider: 'claude', sessionId: SESSION_ID }]);
      assert.deepEqual(frames, [], 'the completed turn must not emit a second complete');
    });
  });
}

test('an idle session remains an error and is never passed to runtime abort', async () => {
  await withGateway(false, async ({ socket, frames, aborts }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();
    assert.deepEqual(aborts, []);
    assert.equal(frames[0]?.code, 'NO_ACTIVE_RUN');
  });
});

test('a failed background abort is reported rather than pretending the work stopped', async () => {
  await withGateway(true, async ({ socket, frames, aborts }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();
    assert.equal(aborts.length, 1);
    assert.equal(frames[0]?.code, 'ABORT_FAILED');
    assert.equal(frames.some((frame) => frame.kind === 'complete'), false);
  }, false);
});

test('a foreground run still emits an aborted complete', async () => {
  await withGateway(false, async ({ socket, frames, aborts, createRun }) => {
    createRun(false);
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();
    assert.deepEqual(aborts, [{ provider: 'claude', sessionId: SESSION_ID }]);
    assert.equal(frames[0]?.kind, 'complete');
    assert.equal(frames[0]?.aborted, true);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('a refused foreground abort keeps the live run registered and reports the failure', async () => {
  await withGateway(false, async ({ socket, frames, createRun }) => {
    createRun(false);
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();
    assert.equal(frames[0]?.code, 'ABORT_FAILED');
    assert.equal(frames.some((frame) => frame.kind === 'complete'), false);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);
  }, false);
});

test('an engine abort exception keeps the live foreground run and reports its session', async () => {
  await withGateway(false, async ({ socket, frames, createRun }) => {
    createRun(false);
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();
    assert.equal(frames[0]?.code, 'ABORT_FAILED');
    assert.equal(frames[0]?.sessionId, SESSION_ID);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);
  }, new Error('Engine refused interrupt'));
});

test('a late successful abort cannot complete a newer foreground turn', async () => {
  await withGateway(false, async ({ socket, frames, createRun, onAbort }) => {
    createRun(false);
    onAbort(() => {
      chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0, reason: 'engine_completed' });
      createRun(false);
    });
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);
    assert.deepEqual(frames, [], 'the older abort must not emit an aborted complete for the new turn');
  });
});

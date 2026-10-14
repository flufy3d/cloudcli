/**
 * OpenCode async prompt lifecycle tests.
 *
 * The runtime now delivers turns through `POST /session/:id/prompt_async`,
 * whose 204 only means "accepted": the turn itself is tracked through the
 * event stream and `/session/status`, with no client-side deadline. These
 * tests drive `spawnOpenCode` against stub engines that pin the new
 * lifecycle: completion on events, completion from status polling when the
 * idle events are lost, the accepted-but-never-started failure, and a
 * mid-turn async injection being answered before the run completes.
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  injectOpenCodeInput,
  spawnOpenCode,
} from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { shutdownOpenCodeServer } from '@/modules/providers/list/opencode/opencode-server.client.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const stubSessionId = 'ses_stub_async';

/**
 * Stub engine with the async prompt endpoint. `STUB_MODE` picks the scenario:
 *
 * - `events`: a normal turn — busy status, streamed reply, idle events, and a
 *   status map that goes absent at the end.
 * - `quiet`: the same turn but every status/idle event is lost; only the reply
 *   deltas reach the stream, and completion must come from `/session/status`.
 * - `dropped`: the prompt is accepted (204) and nothing ever happens.
 * - `inject`: the first turn stays busy in a running tool until a second async
 *   prompt arrives, which it answers alongside the first.
 *
 * Every request body is logged to `STUB_MESSAGE_LOG` with its endpoint prefix,
 * and the blocking endpoint records `message:blocking` if it is ever used.
 */
const openCodeAsyncStubScript = `const http = require('node:http');
const fs = require('node:fs');

const portIndex = process.argv.indexOf('--port');
const port = Number(process.argv[portIndex + 1]);
const sessionId = '${stubSessionId}';
const mode = process.env.STUB_MODE || 'events';
const logPath = process.env.STUB_MESSAGE_LOG;

let streamResponse = null;
let markStreamReady = null;
const streamReady = new Promise((resolve) => {
  markStreamReady = resolve;
});

let statusState = 'absent';
let promptCount = 0;

const writeEvent = (payload) => {
  if (!streamResponse) {
    return;
  }
  streamResponse.write('data: ' + JSON.stringify({ directory: null, payload }) + '\\n\\n');
};

const finishTurn = (messageId, partId, text, delayMs) => {
  setTimeout(() => {
    writeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: sessionId,
        part: { id: partId, messageID: messageId, type: 'text', text, time: { start: 1, end: 2 } },
      },
    });
    statusState = 'absent';
    writeEvent({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
    writeEvent({ type: 'session.idle', properties: { sessionID: sessionId } });
  }, delayMs);
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/global/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ healthy: true }));
    return;
  }

  if (url.pathname === '/global/event') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    streamResponse = response;
    markStreamReady();
    return;
  }

  if (url.pathname === '/session/status') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(statusState === 'busy' ? JSON.stringify({ [sessionId]: { type: 'busy' } }) : '{}');
    return;
  }

  if (url.pathname === '/session' && request.method === 'POST') {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: sessionId }));
    return;
  }

  if (url.pathname === '/session/' + sessionId + '/prompt_async' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      promptCount += 1;
      if (logPath) {
        fs.appendFileSync(logPath, 'prompt_async:' + body + '\\n');
      }
      if (mode !== 'dropped') {
        statusState = 'busy';
      }
      response.writeHead(204);
      response.end();

      void streamReady.then(() => {
        if (mode === 'dropped') {
          return;
        }
        if (mode === 'quiet') {
          writeEvent({ type: 'message.updated', properties: { sessionID: sessionId, info: { id: 'msg_quiet', role: 'assistant' } } });
          writeEvent({
            type: 'message.part.delta',
            properties: { sessionID: sessionId, messageID: 'msg_quiet', partID: 'part_quiet', field: 'text', delta: 'POLL-DONE' },
          });
          // The turn ends without a single status/idle event.
          setTimeout(() => { statusState = 'absent'; }, 400);
          return;
        }
        if (mode === 'inject' && promptCount === 1) {
          writeEvent({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
          writeEvent({ type: 'message.updated', properties: { sessionID: sessionId, info: { id: 'msg_tool', role: 'assistant' } } });
          writeEvent({
            type: 'message.part.updated',
            properties: {
              sessionID: sessionId,
              part: {
                id: 'part_tool',
                messageID: 'msg_tool',
                type: 'tool',
                tool: 'bash',
                callID: 'call_tool',
                state: { status: 'running', input: { command: 'sleep 20' } },
              },
            },
          });
          return;
        }
        if (mode === 'inject') {
          // The injected message is answered here, then the whole turn ends.
          writeEvent({
            type: 'message.part.updated',
            properties: {
              sessionID: sessionId,
              part: {
                id: 'part_tool',
                messageID: 'msg_tool',
                type: 'tool',
                tool: 'bash',
                callID: 'call_tool',
                state: { status: 'completed', input: { command: 'sleep 20' }, output: 'TOOL_OK' },
              },
            },
          });
          writeEvent({ type: 'message.updated', properties: { sessionID: sessionId, info: { id: 'msg_injected', role: 'assistant' } } });
          writeEvent({
            type: 'message.part.delta',
            properties: { sessionID: sessionId, messageID: 'msg_injected', partID: 'part_injected', field: 'text', delta: 'INJ-ANSWER' },
          });
          finishTurn('msg_injected', 'part_injected', 'INJ-ANSWER', 200);
          return;
        }
        // Default: a normal fully-signalled turn.
        writeEvent({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
        writeEvent({ type: 'message.updated', properties: { sessionID: sessionId, info: { id: 'msg_async', role: 'assistant' } } });
        writeEvent({
          type: 'message.part.delta',
          properties: { sessionID: sessionId, messageID: 'msg_async', partID: 'part_async', field: 'text', delta: 'ASYNC-DONE' },
        });
        finishTurn('msg_async', 'part_async', 'ASYNC-DONE', 300);
      });
    });
    return;
  }

  if (url.pathname === '/session/' + sessionId + '/message' && request.method === 'POST') {
    request.resume();
    if (logPath) {
      fs.appendFileSync(logPath, 'message:blocking\\n');
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ info: { id: 'msg_blocking_unexpected' } }));
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{}');
});

server.listen(port, '127.0.0.1');
`;

/** Writes a PATH entry that resolves the `opencode` command to the stub. */
async function writeOpenCodeShim(binDir: string, stubPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'opencode.cmd'), `@echo off\r\nnode "${stubPath}" %*\r\n`);
    return;
  }

  const shimPath = path.join(binDir, 'opencode');
  await writeFile(shimPath, `#!/bin/sh\nexec node "${stubPath}" "$@"\n`);
  await chmod(shimPath, 0o755);
}

/** Polls until `condition` holds; fails the test after the deadline. */
async function waitForCondition(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met in time');
}

type StubHarness = {
  messages: NormalizedMessage[];
  writer: ProviderRuntimeWriter;
  context: ProviderRuntimeContext;
  readLog: () => Promise<string[]>;
};

/**
 * Boots one stub-mode run: PATH shim, app database, writer and runtime context.
 * `run` receives the harness and owns the test body; teardown is automatic.
 */
async function withOpenCodeAsyncStub(
  mode: string,
  run: (harness: StubHarness) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `opencode-async-${mode}-`));
  const binDir = path.join(tempRoot, 'bin');
  const previousPath = process.env.PATH;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousMessageLog = process.env.STUB_MESSAGE_LOG;
  const previousStubMode = process.env.STUB_MODE;
  const previousHomeDir = os.homedir;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  process.env.STUB_MODE = mode;
  process.env.STUB_MESSAGE_LOG = path.join(tempRoot, 'messages.log');
  await initializeDatabase();
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;

  try {
    await mkdir(binDir, { recursive: true });
    const stubPath = path.join(tempRoot, 'opencode-async-stub.cjs');
    await writeFile(stubPath, openCodeAsyncStubScript);
    await writeOpenCodeShim(binDir, stubPath);

    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;

    const messages: NormalizedMessage[] = [];
    const writer: ProviderRuntimeWriter = {
      userId: null,
      send: (message) => {
        messages.push(message as NormalizedMessage);
      },
    };
    const sessionsProvider = new OpenCodeSessionsProvider();
    const context = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async (_sessionId: string | undefined, model?: string | null) =>
        model ?? 'opencode-go/deepseek-v4.1-flash',
      getProviderModels: async () => ({}),
      normalizeMessage: (raw: unknown, sessionId: string | null) =>
        sessionsProvider.normalizeMessage(raw, sessionId),
      isProviderInstalled: async () => true,
    } as unknown as ProviderRuntimeContext;

    await run({
      messages,
      writer,
      context,
      readLog: async () => {
        try {
          return (await readFile(process.env.STUB_MESSAGE_LOG as string, 'utf8')).trim().split('\n').filter(Boolean);
        } catch {
          return [];
        }
      },
    });
  } finally {
    shutdownOpenCodeServer();
    (os as unknown as { homedir: () => string }).homedir = previousHomeDir;
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousMessageLog === undefined) {
      delete process.env.STUB_MESSAGE_LOG;
    } else {
      process.env.STUB_MESSAGE_LOG = previousMessageLog;
    }
    if (previousStubMode === undefined) {
      delete process.env.STUB_MODE;
    } else {
      process.env.STUB_MODE = previousStubMode;
    }
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('an async turn completes through events and never touches the blocking endpoint', async () => {
  await withOpenCodeAsyncStub('events', async ({ messages, writer, context, readLog }) => {
    await spawnOpenCode('hello', { sessionId: 'app-sess-async', cwd: process.cwd() }, writer, context);

    const completeIndex = messages.findIndex((message) => message.kind === 'complete');
    assert.ok(completeIndex !== -1, 'the run must end with a complete frame');
    const streamed = messages
      .slice(0, completeIndex)
      .filter((message) => message.kind === 'stream_delta')
      .map((message) => message.content)
      .join('');
    assert.equal(streamed, 'ASYNC-DONE');

    const log = await readLog();
    assert.equal(log.length, 1, 'the prompt must be delivered exactly once');
    assert.match(log[0] ?? '', /^prompt_async:/);
    assert.ok(!log.some((line) => line.startsWith('message:blocking')), 'the blocking endpoint must not be used');
  });
});

test('a turn whose idle events are lost still completes through the status poll', async () => {
  await withOpenCodeAsyncStub('quiet', async ({ messages, writer, context }) => {
    await spawnOpenCode('hello', { sessionId: 'app-sess-quiet', cwd: process.cwd() }, writer, context);

    const completeIndex = messages.findIndex((message) => message.kind === 'complete');
    assert.ok(completeIndex !== -1, 'the run must end with a complete frame');
    const streamed = messages
      .slice(0, completeIndex)
      .filter((message) => message.kind === 'stream_delta')
      .map((message) => message.content)
      .join('');
    assert.equal(streamed, 'POLL-DONE');
  });
});

test('a prompt the engine accepts but never starts fails the run with a real error', async () => {
  await withOpenCodeAsyncStub('dropped', async ({ messages, writer, context }) => {
    const previousStartTimeout = process.env.OPENCODE_PROMPT_START_TIMEOUT_MS;
    process.env.OPENCODE_PROMPT_START_TIMEOUT_MS = '1200';
    try {
      // A failed run rejects after cleanup; its error frame rides the writer.
      await assert.rejects(
        spawnOpenCode('hello', { sessionId: 'app-sess-dropped', cwd: process.cwd() }, writer, context),
        /never started/,
      );
    } finally {
      if (previousStartTimeout === undefined) {
        delete process.env.OPENCODE_PROMPT_START_TIMEOUT_MS;
      } else {
        process.env.OPENCODE_PROMPT_START_TIMEOUT_MS = previousStartTimeout;
      }
    }

    assert.ok(
      messages.some((message) => message.kind === 'error' && /never started/.test(message.content ?? '')),
      'the dropped prompt must surface as an error',
    );
    assert.ok(messages.some((message) => message.kind === 'complete'), 'the run must still end terminally');
  });
});

test('a message injected mid-turn is answered before the async run completes', async () => {
  await withOpenCodeAsyncStub('inject', async ({ messages, writer, context, readLog }) => {
    const runPromise = spawnOpenCode('hello', { sessionId: 'app-sess-inject', cwd: process.cwd() }, writer, context);
    runPromise.catch(() => {});

    await waitForCondition(() => messages.some((message) => message.kind === 'tool_use'));

    const accepted = await injectOpenCodeInput('follow-up note', { sessionId: 'app-sess-inject' });
    assert.equal(accepted, true, 'the live run must take the injected message');

    await runPromise;

    const completes = messages.filter((message) => message.kind === 'complete');
    assert.equal(completes.length, 1, 'only one complete frame may end the turn');
    const completeIndex = messages.findIndex((message) => message.kind === 'complete');
    assert.ok(
      messages
        .slice(0, completeIndex)
        .some((message) => message.kind === 'stream_delta' && message.content === 'INJ-ANSWER'),
      'the injected turn must stream into the same client turn before complete',
    );

    const log = await readLog();
    const prompts = log.filter((line) => line.startsWith('prompt_async:'));
    assert.equal(prompts.length, 2, 'the prompt and the injection must both go through prompt_async');
    assert.ok(!log.some((line) => line.startsWith('message:blocking')), 'the blocking endpoint must not be used');
  });
});

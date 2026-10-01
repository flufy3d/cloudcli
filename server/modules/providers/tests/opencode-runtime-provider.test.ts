/**
 * OpenCode runtime context-budget tests.
 *
 * OpenCode only reports token usage once a run finishes, which left the
 * composer's context badge frozen throughout a long tool loop. These tests
 * drive `spawnOpenCode` against a stub `opencode serve` (a PATH shim pointing
 * at a local HTTP server that replays the event envelope) and pin that a
 * `token_budget` frame is published while the turn is still running, in
 * addition to the frame the run tail always sent.
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { openCodePermissions } from '@/modules/providers/list/opencode/opencode-permissions.provider.js';
import {
  drainOpenCodeRun,
  spawnOpenCode,
  trackOpenCodeSessionIdle,
} from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { shutdownOpenCodeServer } from '@/modules/providers/list/opencode/opencode-server.client.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const stubSessionId = 'ses_stub_live';
const stubChildSessionId = 'ses_stub_child';

/**
 * Minimal OpenCode server: health probe, event stream, session create, and one
 * blocking message POST. The POST emits `message.updated` for an assistant
 * step and only then answers, so the runtime has to publish the running turn's
 * budget before the request resolves — exactly the ordering a real tool loop
 * produces.
 */
const openCodeStubScript = `const http = require('node:http');

const portIndex = process.argv.indexOf('--port');
const port = Number(process.argv[portIndex + 1]);
const sessionId = '${stubSessionId}';

let streamResponse = null;
let markStreamReady = null;
const streamReady = new Promise((resolve) => {
  markStreamReady = resolve;
});

const writeEvent = (payload) => {
  if (!streamResponse) {
    return;
  }
  streamResponse.write('data: ' + JSON.stringify({ directory: null, payload }) + '\\n\\n');
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

  if (url.pathname === '/session' && request.method === 'POST') {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: sessionId }));
    return;
  }

  if (url.pathname === '/session/' + sessionId + '/message' && request.method === 'POST') {
    request.resume();
    void streamReady.then(() => {
      writeEvent({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: { id: 'message-stub-assistant', role: 'assistant' },
        },
      });
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ info: { id: 'message-stub-assistant' } }));
      }, 300);
    });
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{}');
});

server.listen(port, '127.0.0.1');
`;

/**
 * Stub for the subagent-approval scenario: the blocking message POST emits a
 * `permission.asked` raised by a child session (not the run's own), serves that
 * child's `parentID` on `GET /session/:id`, and only answers once the runtime
 * posts the approval reply — so the run cannot finish unless the child ask was
 * bridged to the parent chat and answered. The reply body is logged to
 * `STUB_REPLY_LOG` for the test to assert.
 */
const openCodeSubagentStubScript = `const http = require('node:http');
const fs = require('node:fs');

const portIndex = process.argv.indexOf('--port');
const port = Number(process.argv[portIndex + 1]);
const parentSessionId = '${stubSessionId}';
const childSessionId = '${stubChildSessionId}';
const replyLogPath = process.env.STUB_REPLY_LOG;

let streamResponse = null;
let markStreamReady = null;
const streamReady = new Promise((resolve) => {
  markStreamReady = resolve;
});

let markPermissionReplied = null;
const permissionReplied = new Promise((resolve) => {
  markPermissionReplied = resolve;
});

const writeEvent = (payload) => {
  if (!streamResponse) {
    return;
  }
  streamResponse.write('data: ' + JSON.stringify({ directory: null, payload }) + '\\n\\n');
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

  if (url.pathname === '/session' && request.method === 'POST') {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: parentSessionId }));
    return;
  }

  if (url.pathname === '/session/' + childSessionId && request.method === 'GET') {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: childSessionId, parentID: parentSessionId }));
    return;
  }

  if (url.pathname === '/session/' + parentSessionId + '/message' && request.method === 'POST') {
    request.resume();
    void streamReady.then(() => {
      writeEvent({
        type: 'permission.asked',
        properties: {
          id: 'per_stub_child_1',
          sessionID: childSessionId,
          permission: 'external_directory',
          patterns: ['C:\\\\Temp\\\\*'],
          metadata: { filepath: 'C:\\\\Temp\\\\stub.mjs' },
          tool: { messageID: 'msg_stub_child', callID: 'call_stub_child' },
        },
      });
    });
    void permissionReplied.then(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ info: { id: 'msg-stub-done' } }));
    });
    return;
  }

  if (url.pathname === '/permission/per_stub_child_1/reply' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (replyLogPath) {
        fs.writeFileSync(replyLogPath, body);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('true');
      markPermissionReplied();
    });
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{}');
});

server.listen(port, '127.0.0.1');
`;

/**
 * Stub for the stream-tail race: the blocking message POST answers right after
 * the final reply's first delta, and only then does the stream carry the rest
 * of that reply, its completed part and `session.idle` — the ordering the real
 * engine produces (the response beats the stream tail by a few milliseconds).
 */
const openCodeTailStubScript = `const http = require('node:http');

const portIndex = process.argv.indexOf('--port');
const port = Number(process.argv[portIndex + 1]);
const sessionId = '${stubSessionId}';
const messageId = 'msg_stub_final';
const partId = 'prt_stub_final_text';

let streamResponse = null;
let markStreamReady = null;
const streamReady = new Promise((resolve) => {
  markStreamReady = resolve;
});

const writeEvent = (payload) => {
  if (!streamResponse) {
    return;
  }
  streamResponse.write('data: ' + JSON.stringify({ directory: null, payload }) + '\\n\\n');
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

  if (url.pathname === '/session' && request.method === 'POST') {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: sessionId }));
    return;
  }

  if (url.pathname === '/session/' + sessionId + '/message' && request.method === 'POST') {
    request.resume();
    void streamReady.then(() => {
      writeEvent({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
      writeEvent({ type: 'message.updated', properties: { sessionID: sessionId, info: { id: messageId, role: 'assistant' } } });
      writeEvent({
        type: 'message.part.updated',
        properties: { sessionID: sessionId, part: { id: partId, messageID: messageId, type: 'text', text: '', time: { start: 1 } } },
      });
      writeEvent({
        type: 'message.part.delta',
        properties: { sessionID: sessionId, messageID: messageId, partID: partId, field: 'text', delta: 'A' },
      });
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ info: { id: messageId } }));
        setTimeout(() => {
          writeEvent({
            type: 'message.part.delta',
            properties: { sessionID: sessionId, messageID: messageId, partID: partId, field: 'text', delta: '-DONE B-SEEN' },
          });
          writeEvent({
            type: 'message.part.updated',
            properties: {
              sessionID: sessionId,
              part: { id: partId, messageID: messageId, type: 'text', text: 'A-DONE B-SEEN', time: { start: 1, end: 2 } },
            },
          });
          writeEvent({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
          writeEvent({ type: 'session.idle', properties: { sessionID: sessionId } });
        }, 100);
      }, 100);
    });
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

/**
 * Seeds the engine DB and model cache the live read consumes: one finished
 * assistant step at 52,027 tokens inside a 1M window.
 */
async function seedOpenCodeContextUsage(homeDir: string): Promise<void> {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)')
      .run(stubSessionId, 1_700_000_000_000, 1_700_000_002_000);
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
      .run(
        'message-stub-assistant',
        stubSessionId,
        1_700_000_001_000,
        1_700_000_002_000,
        JSON.stringify({
          role: 'assistant',
          providerID: 'opencode-go',
          modelID: 'deepseek-v4.1-flash',
          tokens: {
            total: 52_027,
            input: 13_510,
            output: 366,
            reasoning: 0,
            cache: { read: 38_151, write: 0 },
          },
        }),
      );
  } finally {
    db.close();
  }

  const cacheDir = path.join(homeDir, '.cache', 'opencode');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    path.join(cacheDir, 'models.json'),
    JSON.stringify({
      'opencode-go': {
        models: {
          'deepseek-v4.1-flash': { limit: { context: 1_000_000, output: 384_000 } },
        },
      },
    }),
  );
}

test('a running OpenCode turn publishes its context budget before it completes', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-live-budget-'));
  const binDir = path.join(tempRoot, 'bin');
  const previousPath = process.env.PATH;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHomeDir = os.homedir;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;

  try {
    await mkdir(binDir, { recursive: true });
    const stubPath = path.join(tempRoot, 'opencode-stub.cjs');
    await writeFile(stubPath, openCodeStubScript);
    await writeOpenCodeShim(binDir, stubPath);
    await seedOpenCodeContextUsage(tempRoot);

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

    await spawnOpenCode('hello', { sessionId: 'app-sess-live', cwd: tempRoot }, writer, context);

    const budgetFrames = messages.filter(
      (message) => message.kind === 'status' && message.text === 'token_budget',
    );
    const completeIndex = messages.findIndex((message) => message.kind === 'complete');
    assert.ok(completeIndex !== -1, 'the run must still end with a complete frame');
    // One frame while the prompt request was still pending, one from the run
    // tail. Before the mid-turn publish existed, only the tail frame arrived.
    assert.equal(budgetFrames.length, 2, 'a running turn must publish its context usage');

    const liveFrame = budgetFrames[0];
    assert.ok(liveFrame);
    assert.ok(
      messages.indexOf(liveFrame) < completeIndex,
      'the context frame must arrive before the terminal complete',
    );

    // The same shape `/token-usage` returns, addressed to the app session so
    // clients viewing another conversation ignore it.
    assert.equal(liveFrame.sessionId, 'app-sess-live');
    assert.deepEqual(liveFrame.tokenBudget, {
      used: 52_027,
      total: 1_000_000,
      inputTokens: 51_661,
      outputTokens: 366,
      breakdown: { input: 51_661, output: 366 },
      cumulative: { used: 52_027, inputTokens: 51_661, outputTokens: 366 },
    });
  } finally {
    shutdownOpenCodeServer();
    (os as unknown as { homedir: () => string }).homedir = previousHomeDir;
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a subagent approval surfaces on the parent run and its reply reaches the engine', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-subagent-approval-'));
  const binDir = path.join(tempRoot, 'bin');
  const previousPath = process.env.PATH;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousReplyLog = process.env.STUB_REPLY_LOG;
  const previousHomeDir = os.homedir;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  process.env.STUB_REPLY_LOG = path.join(tempRoot, 'reply.json');
  await initializeDatabase();
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;

  try {
    await mkdir(binDir, { recursive: true });
    const stubPath = path.join(tempRoot, 'opencode-subagent-stub.cjs');
    await writeFile(stubPath, openCodeSubagentStubScript);
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

    const runPromise = spawnOpenCode(
      'hello',
      { sessionId: 'app-sess-child-approval', cwd: tempRoot },
      writer,
      context,
    );
    // The awaited promise below reports failures; keep a rejected run from
    // surfacing as an unhandled rejection when shutdown races it.
    runPromise.catch(() => {});

    await waitForCondition(() =>
      messages.some((message) => message.kind === 'permission_request'));
    const card = messages.find((message) => message.kind === 'permission_request');
    assert.ok(card, 'the child ask must bridge into a card on the parent run');
    assert.equal(card.requestId, 'per_stub_child_1');
    assert.equal(card.sessionId, 'app-sess-child-approval');
    assert.equal(card.toolName, 'external_directory');

    openCodePermissions.resolve('per_stub_child_1', { allow: true });

    await runPromise;
    assert.ok(
      messages.some((message) => message.kind === 'complete'),
      'the run must finish once the child approval was answered',
    );

    const replyBody = JSON.parse(await readFile(process.env.STUB_REPLY_LOG as string, 'utf8'));
    assert.deepEqual(replyBody, { reply: 'once' });
  } finally {
    shutdownOpenCodeServer();
    (os as unknown as { homedir: () => string }).homedir = previousHomeDir;
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousReplyLog === undefined) {
      delete process.env.STUB_REPLY_LOG;
    } else {
      process.env.STUB_REPLY_LOG = previousReplyLog;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('the final reply streams completely when the prompt request resolves before its stream tail', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-stream-tail-'));
  const binDir = path.join(tempRoot, 'bin');
  const previousPath = process.env.PATH;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHomeDir = os.homedir;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;

  try {
    await mkdir(binDir, { recursive: true });
    const stubPath = path.join(tempRoot, 'opencode-tail-stub.cjs');
    await writeFile(stubPath, openCodeTailStubScript);
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

    await spawnOpenCode('hello', { sessionId: 'app-sess-tail', cwd: tempRoot }, writer, context);

    const completeIndex = messages.findIndex((message) => message.kind === 'complete');
    assert.ok(completeIndex !== -1, 'the run must end with a complete frame');
    const streamed = messages
      .slice(0, completeIndex)
      .filter((message) => message.kind === 'stream_delta')
      .map((message) => message.content)
      .join('');
    // Before the drain, the run unsubscribed on the response and only "A" streamed.
    assert.equal(streamed, 'A-DONE B-SEEN');
  } finally {
    shutdownOpenCodeServer();
    (os as unknown as { homedir: () => string }).homedir = previousHomeDir;
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

type DrainableRun = {
  injections: Set<Promise<unknown>>;
  engineIdle: boolean;
  idleWaiters: Set<() => void>;
  aborted: boolean;
};

function createDrainableRun(): DrainableRun {
  return { injections: new Set(), engineIdle: false, idleWaiters: new Set(), aborted: false };
}

const sessionIdleEvent = { type: 'session.idle', properties: { sessionID: 'ses_x' }, directory: null };
const sessionStatusEvent = (type: string) => ({
  type: 'session.status',
  properties: { sessionID: 'ses_x', status: { type } },
  directory: null,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('session status events track whether the engine is idle', () => {
  const run = createDrainableRun();
  trackOpenCodeSessionIdle(run, sessionStatusEvent('idle'));
  assert.equal(run.engineIdle, true);
  trackOpenCodeSessionIdle(run, sessionStatusEvent('busy'));
  assert.equal(run.engineIdle, false);
  trackOpenCodeSessionIdle(run, sessionIdleEvent);
  assert.equal(run.engineIdle, true);
  trackOpenCodeSessionIdle(run, sessionStatusEvent('retry'));
  assert.equal(run.engineIdle, false);
  // Unrelated events and unknown statuses leave the state alone.
  trackOpenCodeSessionIdle(run, sessionStatusEvent('mystery'));
  trackOpenCodeSessionIdle(run, { type: 'message.updated', properties: {}, directory: null });
  assert.equal(run.engineIdle, false);
});

test('draining a run waits for the idle event and ends as soon as it arrives', async () => {
  const run = createDrainableRun();
  let drained = false;
  const drain = drainOpenCodeRun(run, 10_000).then(() => {
    drained = true;
  });

  await sleep(30);
  assert.equal(drained, false, 'the run must wait for its stream tail');
  trackOpenCodeSessionIdle(run, sessionIdleEvent);
  await drain;
  assert.equal(run.idleWaiters.size, 0);
});

test('draining a run is bounded when the idle event never arrives', async () => {
  const run = createDrainableRun();
  const startedAt = Date.now();
  await drainOpenCodeRun(run, 50);
  assert.ok(Date.now() - startedAt >= 40);
  assert.equal(run.idleWaiters.size, 0);

  // An idle already seen, or a timeout of zero, does not wait at all.
  run.engineIdle = true;
  await drainOpenCodeRun(run, 10_000);
  run.engineIdle = false;
  await drainOpenCodeRun(run, 0);
});

test('a message injected while the run drains is answered and streamed before it ends', async () => {
  const run = createDrainableRun();
  let drained = false;
  const drain = drainOpenCodeRun(run, 10_000).then(() => {
    drained = true;
  });
  await sleep(10);

  // Mirrors `injectOpenCodeInput`: track the request, forget any earlier idle.
  let answer: () => void = () => {};
  const tracked: Promise<void> = new Promise<void>((resolve) => {
    answer = resolve;
  }).finally(() => {
    run.injections.delete(tracked);
  });
  run.injections.add(tracked);

  // The original loop's idle wakes the drain, which must now settle the
  // injection; the loop answering it starts busy again.
  trackOpenCodeSessionIdle(run, sessionIdleEvent);
  trackOpenCodeSessionIdle(run, sessionStatusEvent('busy'));
  await sleep(20);
  assert.equal(drained, false, 'the injected message is still pending');

  answer();
  await sleep(20);
  assert.equal(drained, false, "the injected message's stream tail has not arrived yet");

  trackOpenCodeSessionIdle(run, sessionStatusEvent('idle'));
  await drain;
  assert.equal(run.injections.size, 0);
});

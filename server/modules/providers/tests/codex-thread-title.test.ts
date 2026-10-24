import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexTitleIsolationConfig } from '@/shared/index.js';

import { codexAppServerTransport, type CodexAppServerHandlers } from '../list/codex/codex-app-server.client.js';
import { acquireCodexResidentSession, closeCodexResidentSessions, isCodexResidentSessionBusy } from '../list/codex/codex-session-manager.js';
import { generateCodexThreadTitle } from '../list/codex/codex-thread-title.js';

function install(t: any) {
  let handlers: CodexAppServerHandlers = {};
  const calls: Array<{ method: string; params: any }> = [];
  const fixture = { text: '{"title":"排查重复消息"}', sandbox: 'readOnly', status: 'completed', hang: false, requests: false, startDelay: 0, eventTurn: 'turn', sync: false, lateAnnouncement: false };
  t.mock.method(codexAppServerTransport, 'open', async (input: CodexAppServerHandlers) => {
    handlers = input;
    return {
      call: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'config/read') return { config: { mcp_servers: { personal: { enabled: true }, cloudcli_task_continuations: { command: 'node', enabled: true } } } };
        if (method === 'thread/start') return { thread: { id: params.ephemeral ? 'title' : 'main', ephemeral: !!params.ephemeral }, sandbox: { type: fixture.sandbox } };
        if (method === 'turn/start') {
          if (!fixture.lateAnnouncement) handlers.onNotification?.('turn/started', { threadId: 'title', turn: { id: 'turn' } });
          const emit = () => {
            handlers.onNotification?.('item/completed', { threadId: 'foreign', turnId: 'turn', item: { type: 'agentMessage', text: 'wrong' } });
            if (!fixture.hang) {
              handlers.onNotification?.('item/completed', { threadId: 'title', turnId: fixture.eventTurn, item: { type: 'agentMessage', text: fixture.text } });
              handlers.onNotification?.('turn/completed', { threadId: 'title', turn: { id: fixture.eventTurn, status: fixture.status } });
            }
          };
          if (fixture.sync) emit(); else setImmediate(emit);
          if (fixture.startDelay) await new Promise((resolve) => setTimeout(resolve, fixture.startDelay));
          if (fixture.lateAnnouncement) handlers.onNotification?.('turn/started', { threadId: 'title', turn: { id: 'turn' } });
          return { turn: { id: 'turn' } };
        }
        return {};
      },
      close: () => {},
    };
  });
  return { calls, fixture, get handlers() { return handlers; } };
}

async function resident() {
  const session = await acquireCodexResidentSession({ appSessionId: 'app', nativeThreadId: null, workingDirectory: '/tmp', approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } });
  return { appSessionId: 'app', nativeThreadId: 'main', generation: session.generation, workingDirectory: '/tmp', model: 'chat', models: { DEFAULT: 'chat', OPTIONS: [] } };
}

test('title generation disables tools and consumes only its structured thread result', async (t) => {
  const server = install(t);
  try {
    const target = await resident();
    const values: string[] = [];
    await generateCodexThreadTitle({ target, prompt: '排查重复消息', model: 'gpt-5.6-luna', effort: 'low', deadline: Date.now() + 1000, signal: new AbortController().signal }, async (title) => { values.push(title); });
    assert.deepEqual(values, ['排查重复消息']);
    const start = server.calls.find((call) => call.method === 'thread/start' && call.params.ephemeral)!;
    assert.equal(start.params.sandbox, 'read-only');
    assert.equal(start.params.config['features.shell_tool'], false);
    assert.equal(start.params.config.mcp_servers.personal.enabled, false);
    assert.equal(start.params.config.mcp_servers.cloudcli_task_continuations.enabled, false);
    assert.deepEqual(start.params.dynamicTools, []);
    assert.ok(server.calls.some((call) => call.method === 'thread/unsubscribe' && call.params.threadId === 'title'));
    assert.equal(isCodexResidentSessionBusy('app'), false);
  } finally { closeCodexResidentSessions(); }
});


test('a start reply delayed beyond the deadline still interrupts the announced title turn', async (t) => {
  const server = install(t);
  server.fixture.hang = true;
  server.fixture.startDelay = 80;
  try {
    const target = await resident();
    await assert.rejects(generateCodexThreadTitle({ target, prompt: 'task', model: 'chat', deadline: Date.now() + 25, signal: new AbortController().signal }, async () => {}), { code: 'CODEX_TITLE_TIMEOUT' });
    assert.ok(server.calls.some((call) => call.method === 'turn/interrupt' && call.params.turnId === 'turn'));
    assert.ok(server.calls.some((call) => call.method === 'thread/unsubscribe'));
  } finally { closeCodexResidentSessions(); }
});


test('cancellation before any turn announcement still owns and interrupts a late start', async (t) => {
  const server = install(t);
  server.fixture.hang = true;
  server.fixture.startDelay = 60;
  server.fixture.lateAnnouncement = true;
  try {
    const target = await resident();
    await assert.rejects(generateCodexThreadTitle({ target, prompt: 'task', model: 'chat', deadline: Date.now() + 20, signal: new AbortController().signal }, async () => { assert.fail('cancelled result consumed'); }), { code: 'CODEX_TITLE_TIMEOUT' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(server.calls.some((call) => call.method === 'turn/interrupt' && call.params.turnId === 'turn'));
  } finally { closeCodexResidentSessions(); }
});


for (const text of ['not json', '{"title":""}', '{"title":"a\\nb"}', '{"title":"**bold**"}', '{"title":7}', '{"title":"ok","extra":true}', '[]', JSON.stringify({ title: 'x'.repeat(5000) })]) {
  test(`an invalid title is rejected without consuming raw output: ${text.slice(0, 25)}`, async (t) => {
    const server = install(t);
    server.fixture.text = text;
    try {
      const target = await resident();
      await assert.rejects(generateCodexThreadTitle({ target, prompt: 'task', model: 'chat', deadline: Date.now() + 1000, signal: new AbortController().signal }, async () => { assert.fail('invalid title consumed'); }), { code: 'CODEX_TITLE_OUTPUT' });
      assert.ok(server.calls.some((call) => call.method === 'thread/unsubscribe'));
    } finally { closeCodexResidentSessions(); }
  });
}

test('a non-readonly sandbox fails before inference and is unsubscribed', async (t) => {
  const server = install(t);
  server.fixture.sandbox = 'dangerFullAccess';
  try {
    const target = await resident();
    await assert.rejects(generateCodexThreadTitle({ target, prompt: 'task', model: 'chat', deadline: Date.now() + 1000, signal: new AbortController().signal }, async () => {}), { code: 'CODEX_TITLE_ISOLATION' });
    assert.equal(server.calls.some((call) => call.method === 'turn/start'), false);
    assert.ok(server.calls.some((call) => call.method === 'thread/unsubscribe'));
  } finally { closeCodexResidentSessions(); }
});

test('Unicode output is bounded by characters and the request by UTF8 bytes', async (t) => {
  const server = install(t);
  server.fixture.text = JSON.stringify({ title: '😀'.repeat(50) });
  server.fixture.sync = true;
  try {
    const target = await resident();
    const values: string[] = [];
    await generateCodexThreadTitle({ target, prompt: '😀'.repeat(5000), model: 'chat', deadline: Date.now() + 1000, signal: new AbortController().signal }, async (title) => { values.push(title); });
    assert.equal(values[0], '😀'.repeat(36));
    const text = server.calls.find((call) => call.method === 'turn/start')!.params.input[0].text;
    assert.ok(Buffer.byteLength(text, 'utf8') <= 960);
    assert.equal(text.includes('�'), false);
  } finally { closeCodexResidentSessions(); }
});

test('explicit cancellation interrupts only the title turn and releases the borrow', async (t) => {
  const server = install(t);
  server.fixture.hang = true;
  const controller = new AbortController();
  try {
    const target = await resident();
    const running = generateCodexThreadTitle({ target, prompt: 'task', model: 'chat', deadline: Date.now() + 1000, signal: controller.signal }, async () => {});
    const rejected = assert.rejects(running, { code: 'CODEX_TITLE_CANCELLED' });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    assert.ok(server.calls.some((call) => call.method === 'turn/interrupt' && call.params.threadId === 'title'));
    assert.equal(isCodexResidentSessionBusy('app'), false);
  } finally { closeCodexResidentSessions(); }
});

test('isolation never creates an MCP server without its transport', () => {
  assert.deepEqual(buildCodexTitleIsolationConfig({}).mcp_servers, {});
});

for (const status of ['failed', 'interrupted']) {
  test(`a ${status} title turn never consumes its output`, async (t) => {
    const server = install(t);
    server.fixture.status = status;
    try {
      const target = await resident();
      await assert.rejects(generateCodexThreadTitle({ target, prompt: 'task', model: 'chat', deadline: Date.now() + 1000, signal: new AbortController().signal }, async () => { assert.fail('unsuccessful output consumed'); }), { code: 'CODEX_TITLE_TURN_FAILED' });
    } finally { closeCodexResidentSessions(); }
  });
}

test('an unexpected title interaction is refused and process loss fails without consuming', async (t) => {
  const server = install(t);
  server.fixture.hang = true;
  try {
    const target = await resident();
    const running = generateCodexThreadTitle({ target, prompt: 'task', model: 'chat', deadline: Date.now() + 1000, signal: new AbortController().signal }, async () => { assert.fail('lost process output consumed'); });
    const rejected = assert.rejects(running, { code: 'CODEX_TITLE_PROCESS_LOST' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await server.handlers.onRequest?.('item/commandExecution/requestApproval', { threadId: 'title', turnId: 'turn' }), undefined, 'transport must receive no approval response');
    closeCodexResidentSessions();
    await rejected;
  } finally { closeCodexResidentSessions(); }
});

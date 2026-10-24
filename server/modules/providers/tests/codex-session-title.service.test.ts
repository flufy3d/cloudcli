import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { connectedClients } from '@/modules/websocket/index.js';
import type { CodexSessionTitleTarget } from '@/shared/types.js';

import { CodexSessionsProvider } from '../list/codex/codex-sessions.provider.js';
import { CodexProviderAuth } from '../list/codex/codex-auth.provider.js';
import { codexAppServerTransport, type CodexAppServerHandlers } from '../list/codex/codex-app-server.client.js';
import { acquireCodexResidentSession, closeCodexResidentSessions } from '../list/codex/codex-session-manager.js';
import { codexSessionTitleService } from '../services/codex-session-title.service.js';

let directory: string;
let previousDatabasePath: string | undefined;
test.beforeEach(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  directory = await mkdtemp(path.join(tmpdir(), 'codex-title-service-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
});
test.afterEach(async () => {
  closeCodexResidentSessions();
  connectedClients.clear();
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(directory, { recursive: true, force: true });
});

async function setup(t: any, nativeName: string | null = null) {
  const calls: Array<{ method: string; params: any }> = [];
  let handler: CodexAppServerHandlers;
  const fixture = { nativeName, response: '{"title":"排查重复消息"}', beforeResult: () => {}, saveThrows: false, block: false, active: 0, maximum: 0, provider: 'openai', actualModel: 'chat', finish: () => {} };
  t.mock.method(codexAppServerTransport, 'open', async (handlers: CodexAppServerHandlers) => {
    handler = handlers;
    return {
      call: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: params.ephemeral ? 'title' : 'main', ephemeral: !!params.ephemeral }, sandbox: { type: 'readOnly' } };
        if (method === 'thread/read') return { thread: { id: 'main', name: fixture.nativeName, modelProvider: fixture.provider, model: fixture.actualModel } };
        if (method === 'config/read') return { config: {} };
        if (method === 'thread/name/set') {
          fixture.nativeName = params.name;
          if (fixture.saveThrows) throw new Error('ambiguous save');
        }
        if (method === 'turn/start') {
          fixture.active++;
          fixture.maximum = Math.max(fixture.maximum, fixture.active);
          fixture.finish = () => {
            fixture.beforeResult();
            fixture.active--;
            handler.onNotification?.('item/completed', { threadId: 'title', turnId: 'turn', item: { type: 'agentMessage', text: fixture.response } });
            handler.onNotification?.('turn/completed', { threadId: 'title', turn: { id: 'turn', status: 'completed' } });
          };
          if (!fixture.block) setImmediate(fixture.finish);
          return { turn: { id: 'turn' } };
        }
        return {};
      }, close() {},
    };
  });
  sessionsDb.createAppSession('app', 'codex', directory, '首句');
  sessionsDb.assignProviderSessionId('app', 'main');
  const resident = await acquireCodexResidentSession({ appSessionId: 'app', nativeThreadId: null, workingDirectory: directory, approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } });
  const frames: any[] = [];
  connectedClients.add({ readyState: 1, send: (frame: string) => frames.push(JSON.parse(frame)) } as any);
  return { calls, fixture, frames, target: { appSessionId: 'app', nativeThreadId: 'main', generation: resident.generation, workingDirectory: directory, model: 'chat', models: { DEFAULT: 'chat', OPTIONS: [] }, initialPrompt: '排查重复消息' } as CodexSessionTitleTarget };
}

test('an existing native name only updates local metadata without generating', async (t) => {
  const { calls, frames, target } = await setup(t, '已有原生标题');
  const before = sessionsDb.getSessionById('app')!;
  await codexSessionTitleService.enqueue(target);
  assert.equal(sessionsDb.getSessionById('app')?.custom_name, '已有原生标题');
  assert.equal(sessionsDb.getSessionById('app')?.updated_at, before.updated_at);
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
  assert.equal(calls.some((call) => call.method === 'thread/start' && call.params.ephemeral), false);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].metadataOnly, true);
});


test('an unnamed OAuth session generates once with luna and saves native and local names', async (t) => {
  t.mock.method(CodexProviderAuth.prototype, 'getStatus', async () => ({ installed: true, authenticated: true, method: 'credentials_file', provider: 'codex' }));
  const { calls, fixture, frames, target } = await setup(t);
  target.models.OPTIONS = [{ value: 'gpt-5.6-luna', label: 'Luna', effort: { values: [{ value: 'low' }] } }];
  const before = sessionsDb.getSessionById('app')!;
  await Promise.all([codexSessionTitleService.enqueue(target), codexSessionTitleService.enqueue(target)]);
  assert.equal(fixture.nativeName, '排查重复消息');
  assert.equal(sessionsDb.getSessionById('app')?.custom_name, '排查重复消息');
  assert.equal(sessionsDb.getSessionById('app')?.updated_at, before.updated_at);
  const turns = calls.filter((call) => call.method === 'turn/start');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].params.model, 'gpt-5.6-luna');
  assert.equal(turns[0].params.effort, 'low');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].metadataOnly, true);
});


test('a successful short-connection session gets a manager-owned temporary title worker', async (t) => {
  t.mock.method(CodexProviderAuth.prototype, 'getStatus', async () => ({ authenticated: true, method: 'api_key' }));
  const { target, calls, fixture } = await setup(t);
  closeCodexResidentSessions();
  target.generation = 0;
  await codexSessionTitleService.enqueue(target);
  assert.equal(fixture.nativeName, '排查重复消息');
  assert.equal(sessionsDb.getSessionById('app')?.custom_name, '排查重复消息');
  assert.ok(calls.some((call) => call.method === 'thread/start' && call.params.threadSource === 'cloudcli_title_worker' && call.params.ephemeral));
});


for (const method of ['api_key', 'credentials_file']) {
  test(`title model falls back to the actual chat model for ${method} without an eligible luna`, async (t) => {
    t.mock.method(CodexProviderAuth.prototype, 'getStatus', async () => ({ authenticated: true, method }));
    const { target, calls, fixture } = await setup(t);
    fixture.actualModel = 'actual-chat';
    target.models.OPTIONS = [{ value: 'actual-chat', label: 'Chat', effort: { values: [{ value: 'low' }] } }];
    if (method === 'api_key') target.models.OPTIONS.push({ value: 'gpt-5.6-luna', label: 'Luna' });
    await codexSessionTitleService.enqueue(target);
    const turn = calls.find((call) => call.method === 'turn/start')!;
    assert.equal(turn.params.model, 'actual-chat');
    assert.equal(turn.params.effort, 'low');
  });
}

test('a resumed provider is preserved instead of inheriting the current project default', async (t) => {
  t.mock.method(CodexProviderAuth.prototype, 'getStatus', async () => ({ authenticated: true, method: 'credentials_file' }));
  const { target, fixture, calls } = await setup(t);
  fixture.provider = 'custom-openai-compatible';
  target.models.OPTIONS = [{ value: 'gpt-5.6-luna', label: 'Luna' }];
  await codexSessionTitleService.enqueue(target);
  assert.equal(calls.find((call) => call.method === 'thread/start' && call.params.ephemeral)?.params.modelProvider, fixture.provider);
  assert.equal(calls.find((call) => call.method === 'turn/start')?.params.model, 'chat');
  assert.equal(calls.find((call) => call.method === 'turn/start')?.params.effort, undefined);
});

for (const scenario of ['rename', 'archive', 'delete', 'replace', 'disable']) {
  test(`a ${scenario} during title generation invalidates its result`, async (t) => {
    t.mock.method(CodexProviderAuth.prototype, 'getStatus', async () => ({ authenticated: true, method: 'api_key' }));
    const { target, fixture, calls, frames } = await setup(t);
    fixture.beforeResult = () => {
      if (scenario === 'rename') sessionsDb.updateSessionCustomName('app', '用户标题', { lockName: true });
      if (scenario === 'archive') sessionsDb.updateSessionIsArchived('app', true);
      if (scenario === 'delete') sessionsDb.deleteSessionById('app');
      if (scenario === 'replace') sessionsDb.repointSessionToProviderSession('app', { providerSessionId: 'replacement', jsonlPath: '/tmp/replacement.jsonl' });
      if (scenario === 'disable') codexSessionTitleService.updateSettings(false);
    };
    await codexSessionTitleService.enqueue(target);
    assert.equal(calls.some((call) => call.method === 'thread/name/set'), false);
    assert.equal(frames.length, 0);
    assert.equal(sessionsDb.getSessionById('app')?.custom_name, scenario === 'rename' ? '用户标题' : scenario === 'delete' ? undefined : '首句');
  });
}

test('an ambiguous native save is reread and synced without generating again', async (t) => {
  t.mock.method(CodexProviderAuth.prototype, 'getStatus', async () => ({ authenticated: true, method: 'api_key' }));
  const { target, fixture, calls } = await setup(t);
  fixture.saveThrows = true;
  await codexSessionTitleService.enqueue(target);
  assert.equal(sessionsDb.getSessionById('app')?.custom_name, '排查重复消息');
  await codexSessionTitleService.enqueue(target);
  assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('a name set by another client while generation runs wins the second native read', async (t) => {
  t.mock.method(CodexProviderAuth.prototype, 'getStatus', async () => ({ authenticated: true, method: 'api_key' }));
  const { target, fixture, calls } = await setup(t);
  fixture.beforeResult = () => { fixture.nativeName = '其他客户端的标题'; };
  await codexSessionTitleService.enqueue(target);
  assert.equal(calls.some((call) => call.method === 'thread/name/set'), false);
  assert.equal(sessionsDb.getSessionById('app')?.custom_name, '其他客户端的标题');
});

test('known matching native names and disabled generation submit no engine requests', async (t) => {
  const { target, calls } = await setup(t, '首句');
  const before = calls.length;
  await codexSessionTitleService.enqueue(target, '首句');
  codexSessionTitleService.updateSettings(false);
  await codexSessionTitleService.enqueue(target);
  assert.equal(calls.length, before);
});

test('turns that wait behind a slow job retain the shared total deadline', async (t) => {
  t.mock.method(CodexProviderAuth.prototype, 'getStatus', async () => ({ authenticated: true, method: 'api_key' }));
  const { target, fixture, calls } = await setup(t);
  fixture.block = true;
  const first = codexSessionTitleService.enqueue(target);
  for (let attempt = 0; attempt < 100 && !calls.some((call) => call.method === 'turn/start'); attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call.method === 'turn/start'));
  sessionsDb.createAppSession('queued', 'codex', directory, 'Queued');
  sessionsDb.assignProviderSessionId('queued', 'other-main');
  let settled = false;
  const second = codexSessionTitleService.enqueue({ ...target, appSessionId: 'queued', nativeThreadId: 'other-main' }).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'queued work must not run beside the active title');
  const later = Date.now() + 31_000;
  t.mock.method(Date, 'now', () => later);
  fixture.finish();
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(sessionsDb.getSessionById('queued')?.custom_name, 'Queued');
});


test('existing app sessions name from the earliest real user text rather than injected context', async (t) => {
  t.mock.method(CodexProviderAuth.prototype, 'getStatus', async () => ({ authenticated: true, method: 'api_key' }));
  const { target, calls } = await setup(t);
  delete target.initialPrompt;
  const reads: any[] = [];
  t.mock.method(CodexSessionsProvider.prototype, 'fetchHistory', async (id: string, options: any) => {
    assert.equal(id, 'app');
    reads.push(options);
    const messages = options.limit === 1 ? [{ role: 'user', kind: 'text', content: 'LATEST-NOT-THE-TITLE' }]
      : options.offset === 10 ? Array.from({ length: 50 }, () => ({ role: 'user', kind: 'text', content: '# AGENTS.md instructions for /private' }))
        : [{ role: 'user', kind: 'text', content: '<environment_context>private</environment_context>' }, { role: 'assistant', kind: 'text', content: 'wrong assistant' }, { role: 'user', kind: 'text', content: 'EARLIEST-REAL-USER' }];
    return { messages, total: 60, offset: options.offset ?? 0, limit: options.limit, hasMore: false } as any;
  });
  await codexSessionTitleService.enqueue(target);
  const input = calls.find((call) => call.method === 'turn/start')?.params.input[0].text;
  assert.ok(input?.includes('EARLIEST-REAL-USER'));
  assert.equal(input?.includes('LATEST-NOT-THE-TITLE'), false);
  assert.equal(input?.includes('AGENTS.md'), false);
  assert.deepEqual(reads.map((entry) => entry.offset ?? 0), [0, 10, 0]);
});

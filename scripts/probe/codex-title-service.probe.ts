/** Full production title service against a disposable packaged Codex process.
 * --real copies auth into a temporary home and sends two short model requests.
 * --worker closes the chat process before naming. No production DB is opened.
 */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { connectedClients } from '@/modules/websocket/index.js';
import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { acquireCodexResidentSession, closeCodexResidentSessions, listCodexResidentSessions } from '@/modules/providers/list/codex/codex-session-manager.js';
import { codexSessionTitleService } from '@/modules/providers/services/codex-session-title.service.js';
import { buildCodexTitleIsolationConfig } from '@/shared/index.js';
import { startFakeModel } from './resident-fake-model.js';

const real = process.argv.includes('--real');
const worker = process.argv.includes('--worker');
const root = mkdtempSync(path.join(tmpdir(), 'cloudcli-title-service-'));
const home = path.join(root, 'codex');
mkdirSync(home);
const previousHome = process.env.CODEX_HOME;
const previousDatabase = process.env.DATABASE_PATH;
const originalOpen = codexAppServerTransport.open;
const fake = real ? null : startFakeModel('{"title":"排查重复消息"}');
const events: Array<{ method: string; params: any }> = [];
const frames: any[] = [];
const calls: Array<{ method: string; threadId?: string; model?: string; effort?: string; ephemeral?: boolean }> = [];
const exits: Promise<void>[] = [];
const evidence: Record<string, unknown> = { real, worker };

async function waitForExits(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(exits), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('engine exit timeout')), 3000); })]);
  } finally { clearTimeout(timer); }
}

function quotaSnapshot(result: any) {
  return Object.fromEntries(Object.entries(result.rateLimitsByLimitId ?? {}).map(([name, raw]) => {
    const bucket = raw as any;
    return [name, { primary: bucket.primary, secondary: bucket.secondary, normalModelSlug: bucket.normalModelSlug }];
  }));
}

try {
  await fake?.listening;
  if (real) {
    for (const file of ['auth.json', 'config.toml', 'models_cache.json']) {
      const source = path.join(previousHome || path.join(homedir(), '.codex'), file);
      if (existsSync(source)) copyFileSync(source, path.join(home, file));
    }
  } else {
    writeFileSync(path.join(home, 'config.toml'), `model="probe-model"\nmodel_provider="probe"\n[model_providers.probe]\nname="probe"\nbase_url="http://127.0.0.1:${fake!.port()}/v1"\nwire_api="responses"\n`);
  }
  writeFileSync(path.join(root, 'AGENTS.md'), 'TITLE-PROBE-INJECTED-CONTEXT-DO-NOT-SEND');
  process.env.CODEX_HOME = home;
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  connectedClients.add({ readyState: 1, send: (value: string) => frames.push(JSON.parse(value)) } as any);
  codexAppServerTransport.open = async (handlers, options) => {
    const connection = await originalOpen(handlers, options);
    if (connection.waitForExit) exits.push(connection.waitForExit());
    return { ...connection, call: async (method, params, options) => {
      const p = params as any;
      calls.push({ method, threadId: p?.threadId, model: p?.model, effort: p?.effort, ephemeral: p?.ephemeral });
      return connection.call(method, params, options);
    } };
  };
  const model = real ? 'gpt-5.6-luna' : 'probe-model';
  const resident = await acquireCodexResidentSession({
    appSessionId: 'title-service-probe', nativeThreadId: null, workingDirectory: root,
    approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    config: async (connection) => buildCodexTitleIsolationConfig((await connection.call('config/read', { cwd: root, includeLayers: false }) as any).config),
    onEngineEvent: (method, params) => events.push({ method, params }),
  });
  if (real) {
    const catalog = await resident.connection.call('model/list', { includeHidden: true }) as any;
    assert.ok(catalog.data.some((entry: any) => entry.model === model));
    evidence.quotaBefore = quotaSnapshot(await resident.connection.call('account/rateLimits/read', {}));
  }
  await resident.connection.call('turn/start', { threadId: resident.threadId, model, effort: 'low', input: [{ type: 'text', text: 'Reply OK.' }] });
  for (let i = 0; i < 600 && !events.some((event) => event.method === 'turn/completed'); i++) await delay(50);
  assert.ok(events.some((event) => event.method === 'turn/completed' && event.params.turn.status === 'completed'));
  const native = (await resident.connection.call('thread/read', { threadId: resident.threadId }) as any).thread;
  assert.ok(native.path);
  await delay(250);
  const rollout = readFileSync(native.path);
  sessionsDb.createAppSession('title-service-probe', 'codex', root, '我发现最近的版本容易重复文字');
  sessionsDb.assignProviderSessionId('title-service-probe', resident.threadId);
  const before = sessionsDb.getSessionById('title-service-probe')!;
  const eventCount = events.length;
  if (worker) { closeCodexResidentSessions(); await waitForExits(); }
  await codexSessionTitleService.enqueue({
    appSessionId: 'title-service-probe', nativeThreadId: resident.threadId, generation: worker ? 0 : resident.generation,
    workingDirectory: root, model, models: { DEFAULT: model, OPTIONS: [{ value: model, label: model, effort: { values: [{ value: 'low' }] } }] },
    initialPrompt: '我发现最近的版本容易出现重复文字，排查这个问题',
  });
  const after = sessionsDb.getSessionById('title-service-probe')!;
  assert.ok(after.custom_name && after.custom_name !== before.custom_name, 'service must save a generated title');
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].metadataOnly, true);
  assert.deepEqual(readFileSync(native.path), rollout);
  assert.deepEqual(events.slice(eventCount).filter((event) => !event.method.startsWith('account/')), [], 'title work must never enter chat event callbacks');
  assert.equal(calls.filter((call) => call.method === 'turn/start').length, 2);
  assert.equal(calls.filter((call) => call.method === 'thread/resume').length, 0);
  if (worker) assert.deepEqual(listCodexResidentSessions(), []);
  else {
    assert.equal((await resident.connection.call('thread/read', { threadId: resident.threadId }) as any).thread.name, after.custom_name);
    evidence.quotaAfter = real ? quotaSnapshot(await resident.connection.call('account/rateLimits/read', {})) : null;
  }
  if (fake) {
    const request = JSON.parse(fake.requests.at(-1)!);
    assert.deepEqual(request.tools ?? [], []);
    assert.equal(fake.requests.at(-1)!.includes('TITLE-PROBE-INJECTED-CONTEXT-DO-NOT-SEND'), false);
  }
  const databases = readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name));
  assert.ok(databases.length > 0, 'the persistent thread must have a state database');
  const { default: Database } = await import('better-sqlite3');
  for (const file of databases) {
    const db = new Database(path.join(home, file), { readonly: true });
    try {
      assert.equal((db.prepare('SELECT name FROM threads WHERE id = ?').get(resident.threadId) as any)?.name, after.custom_name);
      assert.equal((db.prepare('SELECT count(*) AS n FROM threads').get() as any).n, 1);
    } finally { db.close(); }
  }
  evidence.title = after.custom_name;
  evidence.titleTurn = calls.filter((call) => call.method === 'turn/start').at(-1);
  evidence.metadataOnly = true;
  evidence.rolloutUnchanged = true;
  evidence.noExtraStoredThreads = true;
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const cleanupErrors: string[] = [];
  const recordFailure = (stage: string) => {
    cleanupErrors.push(stage);
    evidence.status = 'failed';
    process.exitCode = 1;
  };
  try {
    closeCodexResidentSessions();
    await waitForExits();
  } catch { recordFailure('engine_exit'); }
  try { connectedClients.clear(); closeConnection(); }
  catch { recordFailure('database_close'); }
  codexAppServerTransport.open = originalOpen;
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
  try { await fake?.close(); }
  catch { recordFailure('fake_model_close'); }
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch { recordFailure('temporary_home_delete'); }
  if (cleanupErrors.length) evidence.cleanupErrors = cleanupErrors;
  writeFileSync(`${root}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidencePath: `${root}.json`, ...evidence }, null, 2));
}

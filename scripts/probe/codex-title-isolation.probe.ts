/**
 * Isolated Codex title protocol probe. Never touches the user's session store.
 * Run with tsx --tsconfig server/tsconfig.json; --real copies auth/config to
 * a temporary Codex home and spends two short gpt-5.6-luna requests.
 * Without --real, the packaged engine sends requests to the local fake model.
 */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { acquireCodexResidentSession, borrowCodexAuxiliaryThread, closeCodexResidentSessions } from '@/modules/providers/list/codex/codex-session-manager.js';
import { buildCodexTitleIsolationConfig } from '@/shared/index.js';
import { startFakeModel } from './resident-fake-model.js';

const real = process.argv.includes('--real');
const probeRoot = mkdtempSync(path.join(tmpdir(), 'cloudcli-title-probe-'));
const probeHome = path.join(probeRoot, 'codex');
mkdirSync(probeHome);
const evidence: Record<string, unknown> = { real, probeRoot };
const originalOpen = codexAppServerTransport.open;
const exits: Array<Promise<void>> = [];
const announcedThreads: Array<{ id: string; source: string }> = [];
const unsubscribes: Array<{ id: string; status: string }> = [];
const notifications: Array<{ method: string; params: Record<string, any> }> = [];
const chatEvents: Array<{ method: string; params: Record<string, any> }> = [];
const requests: string[] = [];
const fake = real ? null : startFakeModel();
codexAppServerTransport.open = async (handlers, options) => {
  const connection = await originalOpen({
    ...handlers,
    onNotification: (method, params) => {
      if (method === 'thread/started' && params.thread && typeof params.thread === 'object') {
        const thread = params.thread as Record<string, any>;
        announcedThreads.push({ id: thread.id, source: thread.threadSource });
      }
      handlers?.onNotification?.(method, params);
    },
  }, options);
  if (connection.waitForExit) exits.push(connection.waitForExit());
  return {
    ...connection,
    call: async (method, params, options) => {
      const result = await connection.call(method, params, options);
      if (method === 'thread/unsubscribe') unsubscribes.push({ id: (params as any).threadId, status: (result as any).status });
      return result;
    },
  };
};

let isolationConfig: Record<string, unknown> = {};
let auxiliary: Awaited<ReturnType<typeof borrowCodexAuxiliaryThread>> | undefined;
let watcher: ReturnType<typeof watch> | undefined;
let slowReceived!: () => void;
const slowReady = new Promise<void>((resolve) => { slowReceived = resolve; });
// Hold one model request open so interrupt/concurrency has a deterministic
// witness. The engine still speaks its real protocol and performs the stop.
const proxy = real ? null : createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (body.includes('TITLE-INTERRUPT-PROBE')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': held request\n\n');
      slowReceived();
      return;
    }
    const response = await fetch(`http://127.0.0.1:${fake!.port()}${req.url}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    res.writeHead(response.status, { 'content-type': 'text/event-stream' });
    res.end(await response.text());
  } catch (error) { res.destroy(error instanceof Error ? error : new Error(String(error))); }
});

async function waitForTurn(threadId: string, after: number, status = 'completed') {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const terminal = notifications.slice(after).find((event) => event.method === 'turn/completed' && event.params.threadId === threadId);
    if (terminal) {
      assert.equal(terminal.params.turn?.status, status, 'title turn must have the expected terminal status');
      return;
    }
    await delay(50);
  }
  throw new Error('title turn did not complete within 30 seconds');
}

try {
  await fake?.listening;
  if (proxy) await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

  if (real) {
    const sourceHome = process.env.CODEX_HOME || path.join(homedir(), '.codex');
    for (const file of ['auth.json', 'config.toml', 'models_cache.json']) {
      if (existsSync(path.join(sourceHome, file))) copyFileSync(path.join(sourceHome, file), path.join(probeHome, file));
    }
  } else {
    writeFileSync(path.join(probeHome, 'config.toml'), `model = "probe-model"
  model_provider = "probe"
  [model_providers.probe]
  name = "probe"
  base_url = "http://127.0.0.1:${(proxy!.address() as { port: number }).port}/v1"
  env_key = "PROBE_API_KEY"
  wire_api = "responses"
  `);
  }

  const resident = await acquireCodexResidentSession({
    appSessionId: 'title-isolation-probe', nativeThreadId: null, workingDirectory: probeRoot,
    approvalPolicy: 'never', sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    env: () => ({ env: { CODEX_HOME: probeHome, ...(real ? {} : { PROBE_API_KEY: 'probe-key' }) } }),
    config: async (connection) => {
      const effective = await connection.call('config/read', { cwd: probeRoot, includeLayers: false }) as any;
      assert.ok(effective?.config && typeof effective.config === 'object');
      isolationConfig = buildCodexTitleIsolationConfig(effective.config);
      // The persistent thread keeps shell; external servers remain disabled.
      return { ...isolationConfig, 'features.shell_tool': true, 'features.unified_exec': true };
    },
    onEngineEvent: (method, params) => chatEvents.push({ method, params }),
  });
  const call = resident.connection.call;
  const quota = async () => {
    if (!real) return null;
    const result = await call('account/rateLimits/read', {}) as any;
    return Object.fromEntries(Object.entries(result.rateLimitsByLimitId ?? {}).map(([key, value]) => {
      const bucket = value as any;
      return [key, { primary: bucket.primary, secondary: bucket.secondary, normalModelSlug: bucket.normalModelSlug }];
    }));
  };
  evidence.quotaBefore = await quota();
  if (real) {
    const models = await call('model/list', { includeHidden: true }) as any;
    assert.ok(models.data.some((model: any) => model.model === 'gpt-5.6-luna'), 'account must offer the selected title model');
  }
  auxiliary = await borrowCodexAuxiliaryThread({
    appSessionId: resident.appSessionId, generation: resident.generation,
    start: {
      ephemeral: true, cwd: probeRoot, sandbox: 'read-only', approvalPolicy: 'never',
      config: isolationConfig, threadSource: 'thread_title',
      dynamicTools: [], environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [],
    },
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: (method) => { requests.push(method); return undefined; },
  });
  const auxiliaryStart = auxiliary.startResult;
  assert.equal(auxiliaryStart?.sandbox?.type, 'readOnly');
  assert.equal(auxiliaryStart?.thread?.ephemeral, true);
  assert.equal(auxiliaryStart?.thread?.path, null);
  evidence.sandbox = auxiliaryStart?.sandbox?.type;
  evidence.ephemeral = auxiliaryStart?.thread?.ephemeral;
  const before = notifications.length;
  const chatBeforeTurn = chatEvents.length;
  await auxiliary.call('turn/start', {
    threadId: auxiliary.threadId, model: real ? 'gpt-5.6-luna' : 'probe-model', effort: 'low',
    input: [{ type: 'text', text: '给任务“排查多引擎重复消息”生成一个不超过36字的中文标题，只返回 JSON。' }],
    outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
  });
  await waitForTurn(auxiliary.threadId, before);
  const finalItems = notifications.filter((event) => event.method === 'item/completed').map((event) => event.params.item);
  if (real) {
    const answer = finalItems.find((item) => item?.type === 'agentMessage')?.text;
    const parsed = JSON.parse(answer);
    assert.ok(typeof parsed.title === 'string' && parsed.title.trim() && [...parsed.title].length <= 36);
    evidence.generatedTitle = parsed.title;
  } else {
    const body = JSON.parse(fake!.requests.at(-1)!);
    evidence.tools = body.tools;
    assert.deepEqual(body.tools ?? [], [], 'no tools, including shell, may reach the model');
  }
  assert.equal(requests.length, 0, 'title must not ask for interaction');
  const belongsToAuxiliary = (event: typeof chatEvents[number]) =>
    (event.params.threadId ?? event.params.thread_id ?? event.params.thread?.id) === auxiliary!.threadId;
  evidence.startupNotificationsInChat = chatEvents.slice(0, chatBeforeTurn).filter(belongsToAuxiliary).map((event) => event.method);
  const titleEventsInChat = chatEvents.slice(chatBeforeTurn).filter(belongsToAuxiliary);
  evidence.titleTurnEventsInChat = titleEventsInChat.map((event) => event.method);
  assert.deepEqual(evidence.titleTurnEventsInChat, []);
  const listed = await call('thread/list', { limit: 100, modelProviders: [] }) as any;
  assert.equal(listed.data.some((thread: any) => thread.id === auxiliary!.threadId), false);
  const files = readdirSync(probeHome, { recursive: true }).filter((file) => String(file).endsWith('.jsonl'));
  assert.equal(files.some((file) => String(file).includes(auxiliary!.threadId)), false);
  evidence.ephemeralListed = false;
  evidence.ephemeralRollout = false;
  const databases = readdirSync(probeHome).filter((file) => /^state_\d+\.sqlite$/.test(file));
  assert.ok(databases.length > 0, 'a state database must exist for the persistent thread');
  for (const file of databases) {
    const db = new Database(path.join(probeHome, file), { readonly: true, fileMustExist: true });
    try { assert.equal(db.prepare('SELECT id FROM threads WHERE id = ?').get(auxiliary.threadId), undefined); }
    finally { db.close(); }
  }
  evidence.ephemeralInStateDatabase = false;
  let interruptedTurn: { turn: { id: string } } | undefined;
  let interruptAfter = 0;
  if (fake) {
    interruptAfter = notifications.length;
    interruptedTurn = await auxiliary.call('turn/start', {
      threadId: auxiliary.threadId, model: 'probe-model', effort: 'low',
      input: [{ type: 'text', text: 'TITLE-INTERRUPT-PROBE' }],
    }) as typeof interruptedTurn;
    await Promise.race([slowReady, delay(5000, undefined, { ref: false }).then(() => { throw new Error('interrupt probe did not reach the model'); })]);
  }
  // Materialize only the disposable main thread, then watch the exact file
  // the synchronizer watches, so a name-only update can be distinguished.
  await call('turn/start', {
    threadId: resident.threadId, model: real ? 'gpt-5.6-luna' : 'probe-model', effort: 'low',
    input: [{ type: 'text', text: 'Reply OK.' }],
  });
  if (interruptedTurn) {
    await auxiliary.call('turn/interrupt', { threadId: auxiliary.threadId, turnId: interruptedTurn.turn.id });
    await waitForTurn(auxiliary.threadId, interruptAfter, 'interrupted');
    evidence.titleInterruptedWhileChatContinued = true;
  }
  for (let attempt = 0; attempt < 600 && !chatEvents.some((event) => event.method === 'turn/completed'); attempt++) await delay(50);
  assert.ok(chatEvents.some((event) => event.method === 'turn/completed' && event.params.turn?.status === 'completed'));
  if (fake) {
    const mainRequest = JSON.parse(fake.requests.at(-1)!);
    const tools = mainRequest.tools ?? [];
    assert.ok(tools.length > 0, 'the persistent thread must retain tools while the title thread has none');
    evidence.mainToolNames = tools.map((tool: any) => tool.name ?? tool.type);
  }
  const main = await call('thread/read', { threadId: resident.threadId }) as any;
  assert.ok(main.thread.path);
  await delay(300);
  const rolloutBefore = readFileSync(main.thread.path);
  const watchEvents: string[] = [];
  watcher = watch(main.thread.path, (event) => watchEvents.push(event));
  await auxiliary.call('thread/name/set', { threadId: resident.threadId, name: '标题协议隔离探针' });
  await delay(1000);
  const named = await auxiliary.call('thread/read', { threadId: resident.threadId }) as any;
  assert.equal(named.thread.name, '标题协议隔离探针');
  assert.deepEqual(readFileSync(main.thread.path), rolloutBefore);
  assert.equal(watchEvents.length, 0);
  evidence.nativeNameReadable = true;
  evidence.renameRolloutWatchEvents = watchEvents;
  evidence.quotaAfter = await quota();
  await auxiliary.call('thread/unsubscribe', { threadId: auxiliary.threadId });
  auxiliary.release();
  auxiliary = undefined;
  assert.equal((await call('thread/read', { threadId: resident.threadId }) as any).thread.id, resident.threadId);
  evidence.chatReadableAfterRelease = true;
  if (fake) {
    const source = 'cloudcli_title_timeout_probe';
    let timedOut = false;
    try {
      const late = await borrowCodexAuxiliaryThread({
        appSessionId: resident.appSessionId, generation: resident.generation, timeoutMs: 1,
        start: { ephemeral: true, cwd: probeRoot, sandbox: 'read-only', config: isolationConfig, threadSource: source },
        onNotification: () => {},
      });
      await late.call('thread/unsubscribe', { threadId: late.threadId });
      late.release();
    } catch (error) {
      assert.equal((error as { code?: string }).code, 'CODEX_APP_SERVER_TIMEOUT');
      timedOut = true;
    }
    if (timedOut) {
      for (let attempt = 0; attempt < 100 && !announcedThreads.some((thread) => thread.source === source); attempt++) await delay(50);
      const late = announcedThreads.find((thread) => thread.source === source);
      assert.ok(late, 'the engine must announce the late thread');
      for (let attempt = 0; attempt < 100 && !unsubscribes.some((entry) => entry.id === late.id); attempt++) await delay(50);
      const detached = unsubscribes.find((entry) => entry.id === late.id);
      assert.ok(detached, 'the manager must send unsubscribe for the late startup');
      assert.ok(['unsubscribed', 'notSubscribed', 'notLoaded'].includes(detached.status));
      const loaded = await call('thread/loaded/list', {}) as any;
      assert.equal(loaded.data.includes(resident.threadId), true, 'main thread must remain loaded');
      evidence.lateStartupUnsubscribeStatus = detached.status;
      evidence.lateStartupStillLoaded = loaded.data.includes(late.id);
      evidence.lateStartupDetached = true;
    } else evidence.lateStartupDetached = 'not tested: engine answered inside 1ms';
  }
  evidence.modelRequestCount = real ? 2 : fake!.requests.length;
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    watcher?.close();
    if (auxiliary) {
      try { await auxiliary.call('thread/unsubscribe', { threadId: auxiliary.threadId }, { timeoutMs: 2000 }); }
      catch (error) { evidence.cleanupError = error instanceof Error ? error.message : String(error); }
      auxiliary.release();
    }
  } finally {
    const cleanupErrors: string[] = [];
    const recordCleanupFailure = (error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
      evidence.status = 'failed';
      process.exitCode = 1;
    };
    try {
      closeCodexResidentSessions();
      await Promise.race([
        Promise.all(exits),
        delay(3000, undefined, { ref: false }).then(() => { throw new Error('probe engine did not exit within 3 seconds'); }),
      ]);
    } catch (error) { recordCleanupFailure(error); }
    if (proxy) {
      try {
        proxy.closeAllConnections();
        await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
      } catch (error) { recordCleanupFailure(error); }
    }
    try { await fake?.close(); }
    catch (error) { recordCleanupFailure(error); }
    codexAppServerTransport.open = originalOpen;
    try { rmSync(probeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { recordCleanupFailure(error); }
    if (cleanupErrors.length) evidence.cleanupErrors = cleanupErrors;
    // Evidence is outside the disposable auth directory; failures do not
    // prevent process shutdown or deletion of the copied credentials.
    try { writeFileSync(`${probeRoot}.json`, JSON.stringify(evidence, null, 2)); }
    catch (error) { recordCleanupFailure(error); evidence.cleanupErrors = cleanupErrors; }
    console.log(JSON.stringify(evidence, null, 2));
  }
}

#!/usr/bin/env node
/**
 * Probe: what does the packaged Codex app-server do when a second turn is
 * submitted while a turn is already running on the same thread?
 *
 * The product question behind it: a persistent (resident) Codex session lets
 * the engine start a background report turn on its own. When the user sends a
 * message in that window, CloudCLI must not lose the input, must not append it
 * to the report turn silently, and must not start a second turn on the same
 * thread that the engine would treat as the same one.
 *
 * The probe drives the real packaged app-server (`@openai/codex` from
 * node_modules) against a local fake model endpoint, so no real model, no real
 * account, and no production chat is touched.
 *
 * Usage: node scripts/probe/codex-turn-race.probe.mjs [scenario]
 *   scenarios: race-default | race-steer-off | steer-api | all (default)
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CODEX_LAUNCHER = require_.resolve('@openai/codex/bin/codex.js');

/** ------------------------------------------------------------------ fake model endpoint */

/**
 * A minimal Responses-API endpoint.
 *
 * `hold` keeps the request open so the turn stays in progress; `release`
 * answers with a finished assistant message so the turn can complete.
 */
function startFakeModel() {
  const requests = [];
  const held = [];
  let released = false;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url, body });

      if (!released) {
        // Keep the turn in progress. The socket stays open on purpose.
        held.push({ req, res });
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseBody());
    });
  });

  const sseBody = () => {
    const item = {
      id: 'msg_probe',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'probe-ok' }],
    };
    const response = {
      id: 'resp_probe',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'probe-model',
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    return [
      ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
      ['response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      }],
      ['response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: 'probe-ok',
      }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
      ['response.completed', { type: 'response.completed', response }],
    ]
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join('');
  };

  const listening = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    requests,
    server,
    listening,
    port: () => server.address().port,
    release: () => {
      released = true;
      for (const { res } of held.splice(0)) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody());
      }
    },
    close: () => new Promise((resolve) => {
      for (const { res } of held.splice(0)) {
        res.destroy();
      }
      server.close(resolve);
    }),
  };
}

/** ------------------------------------------------------------------ app-server client */

function startAppServer({ codexHome, home, port, featureFlags }) {
  const child = spawn(process.execPath, [CODEX_LAUNCHER, 'app-server'], {
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      PROBE_API_KEY: 'probe-key',
      PATH: process.env.PATH,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const notifications = [];
  const stderr = [];
  let buffer = '';
  let nextId = 1;
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.code} ${message.error.message}`));
        } else {
          resolve(message.result);
        }
        continue;
      }
      if (message.method) {
        notifications.push({ method: message.method, params: message.params, at: Date.now() });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  const call = (method, params, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  const waitFor = (method, predicate = () => true, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = notifications.find((n) => n.method === method && predicate(n.params));
      if (found) { resolve(found); return; }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timeout waiting for notification ${method}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });

  return {
    child,
    notifications,
    stderr,
    call,
    notify,
    waitFor,
    kill: () => { child.kill('SIGKILL'); },
  };
}

/** ------------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeConfig({ codexHome, port, featureFlags }) {
  mkdirSync(codexHome, { recursive: true });
  const featureLines = Object.keys(featureFlags ?? {}).length > 0
    ? `\n[features]\n${Object.entries(featureFlags).map(([key, value]) => `${key} = ${value}`).join('\n')}\n`
    : '';
  const config = `
model = "probe-model"
model_provider = "probe"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.probe]
name = "probe"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "PROBE_API_KEY"
wire_api = "responses"

${featureLines}
`;
  writeFileSync(path.join(codexHome, 'config.toml'), config);
}

/** Extracts the probe markers of a model request so we can see what was delivered. */
function textsOf(request) {
  try {
    const parsed = JSON.parse(request.body);
    const out = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node.text === 'string' && node.type === 'input_text') {
        const markers = node.text.match(/[A-Z-]*PROBE-TEXT/g);
        if (markers) out.push(...markers);
      }
      Object.values(node).forEach(walk);
    };
    walk(parsed.input);
    return out;
  } catch {
    return [];
  }
}

const report = (title, data) => {
  console.log(`\n### ${title}`);
  console.log(JSON.stringify(data, null, 2));
};

/** ------------------------------------------------------------------ scenarios */

async function withServer(config, body) {
  const model = startFakeModel();
  await model.listening;
  const home = mkdtempSync(path.join(tmpdir(), 'codex-race-home-'));
  const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-race-cfg-'));
  writeConfig({ codexHome, port: model.port(), featureFlags: config.featureFlags });
  const server = startAppServer({ codexHome, home, port: model.port() });
  try {
    await server.call('initialize', {
      clientInfo: { name: 'probe', title: 'probe', version: '1' },
      capabilities: config.experimentalApi === false ? {} : { experimentalApi: true },
    });
    server.notify('initialized', {});
    return await body({ server, model, home, codexHome });
  } finally {
    server.kill();
    await model.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
}

async function startThread(server) {
  const result = await server.call('thread/start', {
    cwd: REPO_ROOT,
    approvalPolicy: 'never',
    sandboxPolicy: { mode: 'read-only' },
    config: { 'features.defer_mailbox_preemption': true },
  });
  return result?.thread?.id;
}

/** Scenario: a second `turn/start` arrives while the first turn is running. */
async function scenarioRace(featureFlags, label) {
  return withServer({ featureFlags }, async ({ server, model }) => {
    const threadId = await startThread(server);
    const first = await server.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'FIRST-PROBE-TEXT' }],
      clientUserMessageId: 'client-msg-first',
    });
    const firstTurnId = first?.turn?.id;
    const started = await server.waitFor('turn/started', (p) => p?.threadId === threadId);

    const second = await server.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'SECOND-PROBE-TEXT' }],
      clientUserMessageId: 'client-msg-second',
    }).then((result) => ({ ok: true, result })).catch((error) => ({ ok: false, error: String(error) }));

    await sleep(1_500);
    const beforeRelease = {
      modelRequests: model.requests.length,
      deliveredTexts: model.requests.flatMap(textsOf),
    };

    model.release();
    await server.waitFor('turn/completed', (p) => p?.threadId === threadId).catch(() => null);
    await sleep(500);

    const afterRelease = {
      modelRequests: model.requests.length,
      deliveredTexts: model.requests.flatMap(textsOf),
    };

    const turnStartedIds = server.notifications
      .filter((n) => n.method === 'turn/started')
      .map((n) => ({ turnId: n.params?.turn?.id, clientUserMessageId: n.params?.turn?.clientUserMessageId }));

    report(`${label}: second turn/start during an active turn`, {
      firstTurnId,
      startedEventTurnId: started?.params?.turn?.id,
      secondRequest: second,
      beforeRelease,
      afterRelease,
      turnStartedNotifications: turnStartedIds,
      threadStatusNotifications: server.notifications
        .filter((n) => n.method === 'thread/status/changed')
        .map((n) => n.params),
    });
  });
}

/** Scenario: `turn/steer` with a right and a wrong `expectedTurnId`. */
async function scenarioSteerApi() {
  return withServer({}, async ({ server, model }) => {
    const threadId = await startThread(server);
    const first = await server.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'FIRST-PROBE-TEXT' }],
    });
    const turnId = first?.turn?.id;
    await server.waitFor('turn/started', (p) => p?.threadId === threadId);

    const steerOk = await server.call('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: 'STEER-PROBE-TEXT' }],
    }).then((r) => ({ ok: true, result: r })).catch((e) => ({ ok: false, error: String(e) }));

    const steerWrong = await server.call('turn/steer', {
      threadId,
      expectedTurnId: 'turn-does-not-exist',
      input: [{ type: 'text', text: 'STEER-BOGUS-TEXT' }],
    }).then((r) => ({ ok: true, result: r })).catch((e) => ({ ok: false, error: String(e) }));

    await sleep(1_000);
    report('turn/steer with matching and mismatching expectedTurnId', {
      turnId,
      steerMatching: steerOk,
      steerMismatching: steerWrong,
      deliveredTexts: model.requests.flatMap(textsOf),
    });
  });
}

/**
 * Scenario: the experimental thread queue API.
 *
 * `thread/queue/add` stores the input, `thread/queue/start` asks the engine to
 * start it. The engine checks idleness and reserves the turn atomically, so a
 * busy thread rejects the start instead of merging the input into the running
 * turn. That is the isolation the design needs for a user message that
 * arrives while the engine reports in the background.
 */
async function scenarioQueueApi() {
  return withServer({}, async ({ server, model }) => {
    const threadId = await startThread(server);
    const first = await server.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'FIRST-PROBE-TEXT' }],
    });
    const firstTurnId = first?.turn?.id;
    await server.waitFor('turn/started', (p) => p?.threadId === threadId);

    const added = await server.call('thread/queue/add', {
      threadId,
      input: [{ type: 'text', text: 'QUEUED-PROBE-TEXT' }],
      clientUserMessageId: 'client-msg-queued',
    }).then((r) => ({ ok: true, result: r })).catch((e) => ({ ok: false, error: String(e) }));

    const startWhileBusy = await server.call('thread/queue/start', { threadId })
      .then((r) => ({ ok: true, result: r }))
      .catch((e) => ({ ok: false, error: String(e) }));

    const listWhileBusy = await server.call('thread/queue/list', { threadId })
      .then((r) => ({ ok: true, result: r }))
      .catch((e) => ({ ok: false, error: String(e) }));

    // The running turn finishes; the engine becomes idle.
    model.release();
    await server.waitFor('turn/completed', (p) => p?.threadId === threadId).catch(() => null);
    await sleep(300);

    const startWhileIdle = await server.call('thread/queue/start', { threadId })
      .then((r) => ({ ok: true, result: r }))
      .catch((e) => ({ ok: false, error: String(e) }));

    await sleep(1_000);
    const deliveredBeforeSecondRelease = model.requests.flatMap(textsOf);
    model.release();
    await server.waitFor('turn/completed', (p) => p?.threadId === threadId).catch(() => null);
    await sleep(300);

    report('experimental thread queue API', {
      firstTurnId,
      queueAdd: added,
      queueStartWhileBusy: startWhileBusy,
      queueListWhileBusy: listWhileBusy,
      queueStartWhileIdle: startWhileIdle,
      deliveredTextsBeforeSecondRelease: deliveredBeforeSecondRelease,
      deliveredTexts: model.requests.flatMap(textsOf),
      turnStartedNotifications: server.notifications
        .filter((n) => n.method === 'turn/started')
        .map((n) => n.params?.turn?.id),
      queueChangedNotifications: server.notifications
        .filter((n) => n.method === 'thread/queue/changed')
        .map((n) => n.params),
    });
  });
}

/**
 * Scenario: can the queue path carry the round's model and effort, and is the
 * experimentalApi capability required for the queue methods?
 */
async function scenarioQueueSettings() {
  // 1. Without the experimentalApi capability.
  await withServer({ experimentalApi: false }, async ({ server }) => {
    const threadId = await startThread(server);
    const add = await server.call('thread/queue/add', {
      threadId,
      input: [{ type: 'text', text: 'GATED-PROBE-TEXT' }],
      clientUserMessageId: 'client-msg-gated',
    }).then((r) => ({ ok: true, result: r })).catch((e) => ({ ok: false, error: String(e) }));
    report('thread/queue/add without experimentalApi capability', { add });
  });

  // 2. With the capability: apply thread settings, then queue the input.
  return withServer({ experimentalApi: true }, async ({ server, model }) => {
    const threadId = await startThread(server);

    const settings = await server.call('thread/settings/update', {
      threadId,
      model: 'probe-model-2',
      effort: 'low',
    }).then((r) => ({ ok: true, result: r })).catch((e) => ({ ok: false, error: String(e) }));

    await server.call('thread/queue/add', {
      threadId,
      input: [{ type: 'text', text: 'SETTINGS-PROBE-TEXT' }],
      clientUserMessageId: 'client-msg-settings',
    });

    await sleep(1_500);
    const lastRequest = model.requests.at(-1);
    let requestBody = null;
    try {
      requestBody = JSON.parse(lastRequest?.body ?? '{}');
    } catch {
      requestBody = null;
    }

    report('queued round with thread settings applied', {
      settingsUpdate: settings,
      requestModel: requestBody?.model,
      requestReasoning: requestBody?.reasoning,
      deliveredTexts: model.requests.flatMap(textsOf),
    });
  });
}

/**
 * Scenario: how much does a resident app-server cost?
 *
 * A persistent session keeps the process alive between rounds, so the idle
 * reclaim window and the capacity ceiling have to be chosen from measured
 * numbers rather than guessed.
 */
async function scenarioResource() {
  return withServer({}, async ({ server, model }) => {
    const threadId = await startThread(server);
    await server.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'RESOURCE-PROBE-TEXT' }],
    });
    await sleep(500);
    model.release();
    await server.waitFor('turn/completed', (p) => p?.threadId === threadId).catch(() => null);
    await sleep(500);

    const pid = server.child.pid;
    const ps = spawn('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (chunk) => { out += chunk; });
    await new Promise((resolve) => ps.on('close', resolve));

    const rows = out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [processPid, ppid, rss, ...rest] = line.split(/\s+/);
      return { pid: Number(processPid), ppid: Number(ppid), rssKb: Number(rss), command: rest.join(' ') };
    });
    const childrenOf = new Map();
    for (const row of rows) {
      if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
      childrenOf.get(row.ppid).push(row);
    }
    const group = [];
    const walk = (parentPid) => {
      for (const child of childrenOf.get(parentPid) ?? []) {
        group.push(child);
        walk(child.pid);
      }
    };
    walk(pid);
    const self = rows.find((row) => row.pid === pid);
    const all = self ? [self, ...group] : group;

    report('resident app-server process group', {
      pid,
      processCount: all.length,
      totalRssMb: Number((all.reduce((sum, p) => sum + p.rssKb, 0) / 1024).toFixed(1)),
      processes: all.map((p) => ({ pid: p.pid, rssMb: Number((p.rssKb / 1024).toFixed(1)), command: p.command })),
    });
  });
}

/**
 * Scenario: the exact interleaving of the queue drain and the turn events.
 *
 * The host can only tell its own round's turn apart from an engine report
 * turn by when the queued item is consumed, so the order of
 * `turn/started`, the item's removal and `thread/queue/changed` decides
 * whether attribution is possible at all.
 */
async function scenarioDrainOrdering() {
  return withServer({}, async ({ server, model }) => {
    const threadId = await startThread(server);
    const started = Date.now();
    const timeline = [];
    const note = (label) => timeline.push(`${label} @${Date.now() - started}`);

    // Observe the queue state right after the add returns.
    const added = await server.call('thread/queue/add', {
      threadId,
      input: [{ type: 'text', text: 'DRAIN-ORDER-PROBE-TEXT' }],
      clientUserMessageId: 'client-msg-drain-order',
    }).then((r) => ({ ok: true, result: r })).catch((e) => ({ ok: false, error: String(e) }));
    note('queue/add returned');

    const listAfterAdd = await server.call('thread/queue/list', { threadId })
      .then((r) => ({ ok: true, result: r }))
      .catch((e) => ({ ok: false, error: String(e) }));
    note('queue/list right after add');

    await sleep(1_200);
    const listAfterDrain = await server.call('thread/queue/list', { threadId })
      .then((r) => ({ ok: true, result: r }))
      .catch((e) => ({ ok: false, error: String(e) }));
    note('queue/list after drain');

    report('queue drain ordering on an idle thread', {
      queueAdd: added,
      queueListRightAfterAdd: listAfterAdd,
      queueListAfterDrain: listAfterDrain,
      notifications: server.notifications.map((n) => n.method),
      timeline,
      deliveredTexts: model.requests.flatMap(textsOf),
    });
  });
}

/** ------------------------------------------------------------------ entry */

const scenario = process.argv[2] ?? 'all';
const run = async () => {
  if (scenario === 'all' || scenario === 'race-default') {
    await scenarioRace({}, 'steer default');
  }
  if (scenario === 'all' || scenario === 'race-steer-off') {
    await scenarioRace({ steer: false }, 'features.steer = false');
  }
  if (scenario === 'all' || scenario === 'steer-api') {
    await scenarioSteerApi();
  }
  if (scenario === 'all' || scenario === 'queue-api') {
    await scenarioQueueApi();
  }
  if (scenario === 'all' || scenario === 'queue-settings') {
    await scenarioQueueSettings();
  }
  if (scenario === 'all' || scenario === 'resource') {
    await scenarioResource();
  }
  if (scenario === 'all' || scenario === 'drain-ordering') {
    await scenarioDrainOrdering();
  }
};

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

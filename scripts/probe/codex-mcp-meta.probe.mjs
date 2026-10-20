#!/usr/bin/env node
/**
 * Probe: what does the engine send an MCP server in `tools/call`?
 *
 * The residency design lets the host authorize a task call by the engine's
 * own call identity instead of a per-round secret in the process environment.
 * That identity has to come from somewhere the engine controls, and its exact
 * shape is not part of the app-server protocol schema — the `tools/call`
 * request is the MCP protocol's, not Codex's.
 *
 * This probe runs the packaged app-server against a fake model that asks for
 * an MCP tool, with a probe MCP server that records the raw request.
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

/** Records what the engine sent, and answers the tool call. */
function startProbeMcp(recordPath) {
  const server = spawn(process.execPath, [new URL(import.meta.url).pathname, '--mcp', recordPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return server;
}

/** The MCP server: speaks just enough MCP to serve one tool. */
async function runProbeMcp(recordPath) {
  const readline = await import('node:readline');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const { writeFileSync: write } = await import('node:fs');
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const id = message.id;
    if (message.method === 'initialize') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } },
      })}\n`);
      continue;
    }
    if (message.method === 'tools/list') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [{
            name: 'probe_tool',
            description: 'A tool that only records how it was called.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          }],
        },
      })}\n`);
      continue;
    }
    if (message.method === 'tools/call') {
      write(recordPath, JSON.stringify(message.params, null, 2));
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'probe-ok' }] },
      })}\n`);
      continue;
    }
    if (id !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`);
    }
  }
}

/** The fake model: one function call, then a finished message. */
function startFakeModel(recordPath) {
  const requests = [];
  let released = false;
  const held = [];

  const sseBody = (withCall) => {
    const events = [];
    const item = { id: 'msg_probe', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'probe-ok' }] };
    const response = {
      id: 'resp_probe',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'probe-model',
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    events.push(['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }]);
    if (withCall) {
      const call = { id: 'fc_probe', type: 'function_call', call_id: 'call_probe_1', name: 'probe_tool', arguments: '{}', status: 'completed' };
      events.push(['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...call, status: 'in_progress' } }]);
      events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: call }]);
    } else {
      events.push(['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }]);
      events.push(['response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'probe-ok' }]);
      events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }]);
    }
    events.push(['response.completed', { type: 'response.completed', response }]);
    return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push(body);
      // The first request is answered with a tool call, the second with the
      // message that reports the tool's result.
      const wantsCall = requests.length === 1;
      if (!released) {
        held.push({ res, wantsCall });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseBody(wantsCall));
    });
  });

  const listening = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    listening,
    port: () => server.address().port,
    release: () => {
      released = true;
      for (const { res, wantsCall } of held.splice(0)) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody(wantsCall));
      }
    },
    close: () => new Promise((resolve) => {
      for (const { res } of held.splice(0)) res.destroy();
      server.close(resolve);
    }),
  };
}

async function main() {
  const recordPath = process.argv[3];
  if (process.argv[2] === '--mcp') {
    await runProbeMcp(recordPath);
    return;
  }

  const model = startFakeModel();
  await model.listening;
  const home = mkdtempSync(path.join(tmpdir(), 'codex-meta-home-'));
  const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-meta-cfg-'));
  const mcpRecord = path.join(codexHome, 'mcp-call.json');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(path.join(codexHome, 'config.toml'), `
model = "probe-model"
model_provider = "probe"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.probe]
name = "probe"
base_url = "http://127.0.0.1:${model.port()}/v1"
env_key = "PROBE_API_KEY"
wire_api = "responses"

[mcp_servers.probe]
command = "node"
args = ["${new URL(import.meta.url).pathname}", "--mcp", "${mcpRecord}"]
`);

  const child = spawn(process.execPath, [CODEX_LAUNCHER, 'app-server'], {
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome, PROBE_API_KEY: 'probe-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const notifications = [];
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
        if (message.error) reject(new Error(`${message.error.code} ${message.error.message}`));
        else resolve(message.result);
        continue;
      }
      if (message.method) notifications.push({ method: message.method, params: message.params });
    }
  });
  child.stderr.resume();

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

  try {
    await call('initialize', {
      clientInfo: { name: 'probe', title: 'probe', version: '1' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    const thread = await call('thread/start', { cwd: REPO_ROOT, approvalPolicy: 'never' });
    const threadId = thread?.thread?.id;
    await call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'call the probe tool' }],
    });

    // The first model request asks for the tool; the second one is the answer.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    model.release();
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const { readFileSync, existsSync } = await import('node:fs');
    const recorded = existsSync(mcpRecord) ? readFileSync(mcpRecord, 'utf8') : '(no call recorded)';

    console.log('\n### the tools/call params the engine sent');
    console.log(recorded);
    console.log('\n### the notifications the app-server sent');
    console.log(JSON.stringify(notifications.map((entry) => entry.method), null, 2));
    console.log('\n### the model requests');
    console.log(String(model.requests.length));
    console.log('\n### the mcpToolCall items the app-server reported');
    console.log(JSON.stringify(
      notifications
        .filter((entry) => entry.method === 'item/started' || entry.method === 'item/completed')
        .map((entry) => entry.params?.item)
        .map((item) => ({ type: item?.type, id: item?.id, name: item?.server ?? item?.tool ?? item?.name, callId: item?.callId, server: item?.server })),
      null,
      2,
    ));
  } finally {
    child.kill('SIGKILL');
    await model.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
}

void main();

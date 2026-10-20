/**
 * Probe: can a second process resume a thread the first one released?
 *
 * The resident path replaces the process for a tool result, and the next
 * round resumes the same native thread in the new process. The engine refuses
 * a thread that still has an active writer, so this checks whether a released
 * process really hands the thread over.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json scripts/probe/codex-thread-handover.probe.ts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startFakeModel } from './resident-fake-model.js';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const CODEX_LAUNCHER = require_.resolve('@openai/codex/bin/codex.js');

type AppServer = {
  call: (method: string, params: unknown) => Promise<unknown>;
  exited: Promise<void>;
  kill: () => void;
};

function startAppServer(codexHome: string, home: string): AppServer {
  const child = spawn(process.execPath, [CODEX_LAUNCHER, 'app-server'], {
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => { markExited = resolve; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.code} ${message.error.message}`));
        else resolve(message.result);
      }
    }
  });
  child.stderr.resume();
  child.on('exit', () => markExited());
  const call = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { call, exited, kill: () => child.kill() };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const model = startFakeModel();
  await model.listening;
  const home = mkdtempSync(path.join(tmpdir(), 'codex-handover-home-'));
  const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-handover-cfg-'));
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
`);

  const first = startAppServer(codexHome, home);
  let threadId = '';
  try {
    await first.call('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '1' } });
    const thread = await first.call('thread/start', { cwd: home, approvalPolicy: 'never' }) as any;
    threadId = thread?.thread?.id ?? '';
    console.log('thread:', threadId);
    // A turn makes the thread real: the rollout is what the next process
    // resumes.
    await first.call('turn/start', { threadId, input: [{ type: 'text', text: 'probe' }] });
    await sleep(1_500);
  } finally {
    first.kill();
    await first.exited;
  }

  // While the first process still holds the thread, another process must not
  // be able to read or fork it.
  const holder = startAppServer(codexHome, home);
  try {
    await holder.call('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '1' } });
    await holder.call('thread/resume', { threadId, excludeTurns: true });
    console.log('holder resumed the thread');
    for (const [label, method, params] of [
      ['resume', 'thread/resume', { threadId, excludeTurns: true }],
      ['fork', 'thread/fork', { threadId, cwd: home }],
      ['read', 'thread/turns/list', { threadId, limit: 10 }],
    ] as const) {
      const other = startAppServer(codexHome, home);
      try {
        await other.call('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '1' } });
        await other.call(method, params);
        console.log(`while held: ${label} -> ok`);
      } catch (error) {
        console.log(`while held: ${label} -> ${(error as Error).message}`);
      } finally {
        other.kill();
        await other.exited;
      }
    }
  } finally {
    holder.kill();
    await holder.exited;
  }

  for (const waitMs of [0, 200, 1000]) {
    await sleep(waitMs);
    const second = startAppServer(codexHome, home);
    try {
      await second.call('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '1' } });
      const resumed = await second.call('thread/resume', { threadId, excludeTurns: true }) as any;
      console.log(`after ${waitMs}ms: resumed ->`, resumed?.thread?.id);
    } catch (error) {
      console.log(`after ${waitMs}ms: resume failed ->`, (error as Error).message);
    } finally {
      second.kill();
      await second.exited;
    }
  }

  rmSync(home, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
}

void main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

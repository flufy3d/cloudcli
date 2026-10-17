import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OpenCodeServiceError,
  OpenCodeServiceSupervisor,
} from '@/modules/providers/list/opencode/opencode-service.js';

/**
 * A stand-in for `opencode serve --stdio --port 0`: records the password it
 * received, prints the ready line, then lives until its stdin closes — the
 * same ownership-lease contract the real server honours.
 */
const FAKE_SERVE_SOURCE = `
const fs = require('node:fs');
const capture = process.env.FAKE_SERVE_CAPTURE;
if (capture) fs.writeFileSync(capture, JSON.stringify({ args: process.argv.slice(2), password: process.env.OPENCODE_PASSWORD, cwd: process.cwd() }));
if (process.env.FAKE_SERVE_SILENT === '1') { setInterval(() => {}, 1000); }
else if (process.env.FAKE_SERVE_CRASH === '1') { process.stderr.write('boom: port busy\\n'); process.exit(3); }
else {
  process.stdout.write('starting up\\n');
  process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:' + (process.env.FAKE_SERVE_PORT || '4242') }) + '\\n');
}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

type Harness = {
  dir: string;
  capturePath: string;
  spawnCalls: number;
  makeSupervisor: (overrides?: {
    env?: Record<string, string>;
    resolveEnginePath?: () => string | null;
    getEngineVersion?: () => string | null;
    readyTimeoutMs?: number;
  }) => OpenCodeServiceSupervisor;
};

const withHarness = async (run: (harness: Harness) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-service-'));
  const scriptPath = path.join(dir, 'fake-serve.cjs');
  const capturePath = path.join(dir, 'capture.json');
  await writeFile(scriptPath, FAKE_SERVE_SOURCE);
  const supervisors: OpenCodeServiceSupervisor[] = [];
  const harness: Harness = {
    dir,
    capturePath,
    spawnCalls: 0,
    makeSupervisor: (overrides = {}) => {
      const supervisor = new OpenCodeServiceSupervisor({
        spawn: ((command, args, options) => {
          harness.spawnCalls += 1;
          return nodeSpawn(process.execPath, [scriptPath, ...(args as string[])], {
            ...(options as object),
            env: { ...(options as { env?: NodeJS.ProcessEnv }).env, FAKE_SERVE_CAPTURE: capturePath, ...overrides.env },
          });
        }) as typeof nodeSpawn,
        resolveEnginePath: overrides.resolveEnginePath ?? (() => '/fake/opencode'),
        getEngineVersion: overrides.getEngineVersion ?? (() => '2.0.31'),
        readyTimeoutMs: overrides.readyTimeoutMs ?? 5_000,
        cwd: dir,
      });
      supervisors.push(supervisor);
      return supervisor;
    },
  };
  try {
    await run(harness);
  } finally {
    await Promise.all(supervisors.map((supervisor) => supervisor.shutdown()));
    await rm(dir, { recursive: true, force: true });
  }
};

test('boots the server, derives Basic auth from the lease password, and reuses the endpoint', async () => {
  await withHarness(async (harness) => {
    const supervisor = harness.makeSupervisor({ env: { FAKE_SERVE_PORT: '5151' } });

    const [first, second] = await Promise.all([supervisor.ensureEndpoint(), supervisor.ensureEndpoint()]);
    const third = await supervisor.ensureEndpoint();

    assert.equal(first.url, 'http://127.0.0.1:5151');
    assert.equal(second, first);
    assert.equal(third, first);
    assert.equal(harness.spawnCalls, 1, 'concurrent and repeated calls share one boot');

    const capture = JSON.parse(await readFile(harness.capturePath, 'utf8')) as { args: string[]; password: string };
    assert.deepEqual(capture.args, ['serve', '--stdio', '--port', '0']);
    const expectedAuth = `Basic ${Buffer.from(`opencode:${capture.password}`).toString('base64')}`;
    assert.equal(first.authorization, expectedAuth);
    assert.equal(supervisor.currentEndpoint(), first);
  });
});

test('respawns after the server exits and notifies exit listeners', async () => {
  await withHarness(async (harness) => {
    const supervisor = harness.makeSupervisor();
    const exits: string[] = [];
    supervisor.onExit((endpoint) => exits.push(endpoint.url));

    const first = await supervisor.ensureEndpoint();
    // Simulate a crash: drop the lease from the outside and wait for exit.
    await supervisor.shutdown();
    assert.deepEqual(exits, [first.url]);
    assert.equal(supervisor.currentEndpoint(), null);

    const second = await supervisor.ensureEndpoint();
    assert.equal(harness.spawnCalls, 2);
    assert.equal(second.url, first.url);
  });
});

test('reports a missing CLI without spawning', async () => {
  await withHarness(async (harness) => {
    const supervisor = harness.makeSupervisor({ resolveEnginePath: () => null });
    await assert.rejects(
      supervisor.ensureEndpoint(),
      (error: unknown) => error instanceof OpenCodeServiceError && error.code === 'not_installed',
    );
    assert.equal(harness.spawnCalls, 0);
  });
});

test('refuses a v1 engine before spawning', async () => {
  await withHarness(async (harness) => {
    const supervisor = harness.makeSupervisor({ getEngineVersion: () => '1.19.3' });
    await assert.rejects(
      supervisor.ensureEndpoint(),
      (error: unknown) => error instanceof OpenCodeServiceError && error.code === 'unsupported_version',
    );
    assert.equal(harness.spawnCalls, 0);
  });
});

test('boots when the version is not known yet', async () => {
  await withHarness(async (harness) => {
    const supervisor = harness.makeSupervisor({ getEngineVersion: () => null });
    const endpoint = await supervisor.ensureEndpoint();
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:/);
  });
});

test('times out a server that never reports readiness and terminates it', async () => {
  await withHarness(async (harness) => {
    const supervisor = harness.makeSupervisor({ env: { FAKE_SERVE_SILENT: '1' }, readyTimeoutMs: 300 });
    await assert.rejects(
      supervisor.ensureEndpoint(),
      (error: unknown) => error instanceof OpenCodeServiceError && error.code === 'boot_timeout',
    );
    assert.equal(supervisor.currentEndpoint(), null);
  });
});

test('surfaces stderr when the server dies during boot', async () => {
  await withHarness(async (harness) => {
    const supervisor = harness.makeSupervisor({ env: { FAKE_SERVE_CRASH: '1' } });
    await assert.rejects(
      supervisor.ensureEndpoint(),
      (error: unknown) => error instanceof OpenCodeServiceError
        && error.code === 'boot_failed'
        && error.message.includes('port busy'),
    );
  });
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const tsxEntryPoint = path.join(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');
const serverTsConfig = path.join(repositoryRoot, 'server/tsconfig.json');

async function runIsolatedEntrypoint(input: {
  entryPoint: string;
  input?: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; databasePath: string }> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'task-entrypoint-isolation-'));
  const homeDirectory = path.join(temporaryDirectory, 'home');
  const databasePath = path.join(temporaryDirectory, 'auth.db');
  await mkdir(homeDirectory);
  await writeFile(databasePath, '');

  try {
    const child = spawn(process.execPath, [tsxEntryPoint, '--tsconfig', serverTsConfig, input.entryPoint], {
      cwd: repositoryRoot,
      env: {
        HOME: homeDirectory,
        TMPDIR: temporaryDirectory,
        DATABASE_PATH: databasePath,
        PATH: process.env.PATH ?? '',
        LANG: 'C',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    if (input.input) child.stdin.write(input.input);
    child.stdin.end();
    const [exitCode] = await once(child, 'close') as [number | null];
    const databaseSize = (await stat(databasePath)).size;
    assert.equal(databaseSize, 0, `${input.entryPoint} opened or changed the isolated database: ${stderr}`);
    await assert.doesNotReject(readFile(databasePath));
    return { exitCode, stdout, stderr, databasePath };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('task-runner imports and prints help without opening an isolated database or requiring JWT', async () => {
  const result = await runIsolatedEntrypoint({
    entryPoint: path.join(repositoryRoot, 'server/modules/task-continuations/cli/task-runner.ts'),
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /CloudCLI Background Task Runner/);
});

test('stdio MCP initializes and lists tools without opening an isolated database or requiring JWT', async () => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolation-test', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const result = await runIsolatedEntrypoint({
    entryPoint: path.join(repositoryRoot, 'server/modules/task-continuations/cli/task-continuations-mcp.ts'),
    input,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /cloudcli_task_run/);
});

test('worker rejects invalid input without opening an isolated database or requiring JWT', async () => {
  const result = await runIsolatedEntrypoint({
    entryPoint: path.join(repositoryRoot, 'server/modules/task-continuations/cli/task-continuation-worker.ts'),
    input: '{}',
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /INVALID_TASK_WORKER_INPUT/);
});

import fsSync from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(testsDirectory, `workspace-fixture-${process.pid}`);

let fixtureCount = 0;
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  // A process-exit handler instead of a node:test `after` hook: this module
  // is imported by many test files, and a hook registered from an imported
  // module does not reliably fire. `rmSync` keeps the cleanup synchronous,
  // as required inside an exit handler.
  process.on('exit', () => {
    fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
  });
}

/**
 * Creates a workspace directory beside the test files instead of under the
 * system temporary roots: the workspace-admission gate rejects workspaces
 * inside temporary directories, so a fixture claiming a temp workspace
 * silently fails to index. Engine storage itself can keep living under the
 * temp directory — only the recorded workspace path is checked.
 *
 * Directories are numbered per test file (each file runs in its own process)
 * and removed together when the file's tests finish. The `workspace-fixture-`
 * prefix is git-ignored.
 */
export async function createWorkspaceFixture(): Promise<string> {
  const workspacePath = path.join(fixtureRoot, `ws-${(fixtureCount += 1)}`);
  await mkdir(workspacePath, { recursive: true });
  registerCleanup();
  return workspacePath;
}

/**
 * Names a workspace fixture path without creating it, for callers that make
 * the directory themselves (or deliberately remove it to simulate a reaped
 * workspace).
 */
export function workspaceFixturePath(name: string): string {
  registerCleanup();
  return path.join(fixtureRoot, name);
}

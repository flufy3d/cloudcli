import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { admitsWorkspacePath } from '@/modules/providers/shared/sessions/workspace-admission.js';

async function withIsolatedDatabase(runTest: (scratchDir: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'workspace-admission-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('a vanished workspace never seen before is rejected', async () => {
  await withIsolatedDatabase((scratchDir) => {
    // The exact shape this guard exists for: an engine ran once inside a
    // `mktemp -d` sandbox, the directory was reaped, and every restart used to
    // re-create the ghost project from the engine's own session index.
    assert.equal(admitsWorkspacePath(path.join(scratchDir, 'tmp.e88Dyk0dRW')), false);
  });
});

test('an existing temp-root workspace is a real project', async () => {
  await withIsolatedDatabase((scratchDir) => {
    // Regression guard for 1ff5a900: scratch clones and bug repros under a
    // temp root are ordinary work, and blanket-rejecting them made those
    // sessions disappear from the project list with nothing to explain it.
    assert.equal(admitsWorkspacePath(scratchDir), true);
  });
});

test('a vanished workspace that is already a known project stays admitted', async () => {
  await withIsolatedDatabase((scratchDir) => {
    // An unmounted external volume or a detached network share must keep
    // updating its sessions: the row exists, so the directory being absent
    // says nothing about whether the project is real.
    const unmounted = path.join(scratchDir, 'Volumes', 'archive', 'project');
    projectsDb.ensureProjectPath(unmounted);
    assert.equal(admitsWorkspacePath(unmounted), true);
  });
});

test('package-manager internals are rejected whether or not they exist', async () => {
  await withIsolatedDatabase((scratchDir) => {
    assert.equal(admitsWorkspacePath(path.join(scratchDir, 'node_modules', 'cloudcli')), false);
    assert.equal(
      admitsWorkspacePath('/Users/azrael/Library/pnpm/global/5/.pnpm/cloudcli@x/node_modules/cloudcli'),
      false,
    );
    assert.equal(admitsWorkspacePath(''), false);
    assert.equal(admitsWorkspacePath('   '), false);
  });
});

/**
 * Cross-engine wiring: the gate lives in one module, but it only helps if
 * every synchronizer actually calls it. These drive the two file-scanning
 * indexers end to end against a workspace the system has reaped; the SQLite
 * skeleton's own wiring (antigravity, zcode, opencode) is covered in
 * sqlite-session-synchronizer.test.ts.
 */
function patchHomeDir(nextHomeDir: string): () => void {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
}

test('the claude synchronizer skips a transcript whose cwd has vanished', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'claude-ghost-workspace-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const transcriptDir = path.join(tempRoot, '.claude', 'projects', '-tmp-sandbox');
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, 'claude-ghost.jsonl'),
      `${JSON.stringify({ sessionId: 'claude-ghost', cwd: path.join(tempRoot, 'reaped-sandbox') })}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      assert.equal(await new ClaudeSessionSynchronizer().synchronize(), 0);
      assert.equal(sessionsDb.getSessionByProviderSessionId('claude-ghost'), null);
      assert.equal(projectsDb.getProjectPath(path.join(tempRoot, 'reaped-sandbox')), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('the codex synchronizer skips a rollout whose cwd has vanished', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'codex-ghost-workspace-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '09', '22');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, 'rollout-codex-ghost.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'codex-ghost', cwd: path.join(tempRoot, 'reaped-sandbox') },
      })}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      assert.equal(await new CodexSessionSynchronizer().synchronize(), 0);
      assert.equal(sessionsDb.getSessionByProviderSessionId('codex-ghost'), null);
      assert.equal(projectsDb.getProjectPath(path.join(tempRoot, 'reaped-sandbox')), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

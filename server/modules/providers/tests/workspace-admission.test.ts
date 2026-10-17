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
  await withIsolatedDatabase(() => {
    // The exact shape this guard exists for: an engine ran once, the
    // directory was reaped, and every restart used to re-create the ghost
    // project from the engine's own session index. The path stays outside the
    // system temporary roots so this pins the vanished-and-unknown rule
    // itself, not the temporary-directory rule.
    assert.equal(admitsWorkspacePath('/Volumes/cloudcli-admission-probe/reaped-sandbox'), false);
  });
});

test('a workspace inside a system temporary directory is rejected even when it exists', async () => {
  await withIsolatedDatabase(async (scratchDir) => {
    // Reverses the 1ff5a900 stance: scratch clones and bug repros under a
    // temp root used to be admitted as real work, but engine-driven scratch
    // runs (task review sandboxes, test fixtures) cluttered the project list,
    // so anything inside a system temporary directory now stays out. The
    // directory existing — and even being a registered project — does not
    // rescue it.
    await mkdir(path.join(scratchDir, 'task-review-X3ZEvD'), { recursive: true });
    projectsDb.ensureProjectPath(path.join(scratchDir, 'task-review-X3ZEvD'));

    assert.equal(admitsWorkspacePath(scratchDir), false);
    assert.equal(admitsWorkspacePath(path.join(scratchDir, 'task-review-X3ZEvD')), false);
  });
});

test('the operating-system temporary directory root is rejected even when it was registered before', async () => {
  await withIsolatedDatabase(async () => {
    const temporaryRoot = tmpdir();
    projectsDb.ensureProjectPath(temporaryRoot);

    // Engine runtimes sometimes record their own staging root as cwd; that
    // registration must never bring the root back as a project.
    assert.equal(admitsWorkspacePath(temporaryRoot), false);
  });
});

test('a vanished workspace that is already a known project stays admitted', async () => {
  await withIsolatedDatabase(() => {
    // An unmounted external volume or a detached network share must keep
    // updating its sessions: the row exists, so the directory being absent
    // says nothing about whether the project is real. The path stays outside
    // the system temporary roots so the temporary-directory rule cannot mask
    // this one.
    const unmounted = '/Volumes/archive/project';
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
    const reapedWorkspace = '/Volumes/cloudcli-admission-probe/reaped-sandbox';
    await writeFile(
      path.join(transcriptDir, 'claude-ghost.jsonl'),
      `${JSON.stringify({ sessionId: 'claude-ghost', cwd: reapedWorkspace })}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      assert.equal(await new ClaudeSessionSynchronizer().synchronize(), 0);
      assert.equal(sessionsDb.getSessionByProviderSessionId('claude-ghost'), null);
      assert.equal(projectsDb.getProjectPath(reapedWorkspace), null);
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
    const reapedWorkspace = '/Volumes/cloudcli-admission-probe/reaped-sandbox';
    await writeFile(
      path.join(sessionsDir, 'rollout-codex-ghost.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'codex-ghost', cwd: reapedWorkspace },
      })}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      assert.equal(await new CodexSessionSynchronizer().synchronize(), 0);
      assert.equal(sessionsDb.getSessionByProviderSessionId('codex-ghost'), null);
      assert.equal(projectsDb.getProjectPath(reapedWorkspace), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

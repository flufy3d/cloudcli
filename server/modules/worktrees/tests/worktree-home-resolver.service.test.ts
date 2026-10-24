import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearWorktreeHomeCacheForTests,
  resolveWorktreeHome,
} from '@/modules/worktrees/services/worktree-home-resolver.service.js';

/**
 * Creates a real git repository with one linked worktree, so the resolver is
 * exercised against genuine `git worktree list --porcelain` output.
 *
 * Paths are returned through `realpath` because git reports fully resolved
 * paths (macOS temp directories live behind a `/var` → `/private/var`
 * symlink), while the resolver compares paths as plain strings.
 */
async function withTempRepository(
  runTest: (paths: { repositoryPath: string; worktreePath: string }) => Promise<void>,
): Promise<void> {
  const parentDir = await mkdtemp(path.join(tmpdir(), 'worktree-home-'));
  const repositoryPath = path.join(parentDir, 'repo');
  await mkdir(repositoryPath, { recursive: true });

  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(['init', '-b', 'main'], repositoryPath);
  git(['config', 'user.email', 'test@example.com'], repositoryPath);
  git(['config', 'user.name', 'Test'], repositoryPath);
  await writeFile(path.join(repositoryPath, 'file.txt'), 'content');
  git(['add', '.'], repositoryPath);
  git(['commit', '-m', 'init'], repositoryPath);

  const worktreePath = path.join(parentDir, 'repo-worktrees', 'feat-x');
  git(['worktree', 'add', '-b', 'feat/x', worktreePath], repositoryPath);

  const realRepositoryPath = await realpath(repositoryPath);
  const realWorktreePath = await realpath(worktreePath);

  try {
    await runTest({ repositoryPath: realRepositoryPath, worktreePath: realWorktreePath });
  } finally {
    clearWorktreeHomeCacheForTests();
    await rm(parentDir, { recursive: true, force: true });
  }
}

test('resolveWorktreeHome maps a linked worktree to its main checkout and branch', async () => {
  await withTempRepository(async ({ repositoryPath, worktreePath }) => {
    const home = await resolveWorktreeHome(worktreePath);
    assert.deepEqual(home, { rootPath: repositoryPath, branch: 'feat/x' });
  });
});

test('resolveWorktreeHome returns null for the main checkout itself', async () => {
  await withTempRepository(async ({ repositoryPath }) => {
    const home = await resolveWorktreeHome(repositoryPath);
    assert.equal(home, null);
  });
});

test('resolveWorktreeHome returns null branch for a detached worktree', async () => {
  await withTempRepository(async ({ repositoryPath, worktreePath }) => {
    const parentDir = path.dirname(worktreePath);
    const detachedPath = path.join(parentDir, 'detached');
    execFileSync('git', ['worktree', 'add', '--detach', detachedPath], { cwd: repositoryPath });
    clearWorktreeHomeCacheForTests();

    const home = await resolveWorktreeHome(detachedPath);
    assert.deepEqual(home, { rootPath: repositoryPath, branch: null });
  });
});

test('resolveWorktreeHome returns null outside a git repository', async () => {
  const plainDir = await mkdtemp(path.join(tmpdir(), 'worktree-home-plain-'));
  try {
    const home = await resolveWorktreeHome(plainDir);
    assert.equal(home, null);
  } finally {
    await rm(plainDir, { recursive: true, force: true });
  }
});

test('resolveWorktreeHome returns null for a directory that does not exist', async () => {
  const home = await resolveWorktreeHome('/nonexistent/worktree-home-probe');
  assert.equal(home, null);
});

test('resolveWorktreeHome caches results per directory until cleared', async () => {
  clearWorktreeHomeCacheForTests();
  const cannedPorcelain = [
    'worktree /repo/main',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt',
    'branch refs/heads/feat',
    '',
  ].join('\n');
  let gitCalls = 0;
  const countingRunner = async () => {
    gitCalls += 1;
    return { stdout: cannedPorcelain, stderr: '' };
  };

  const first = await resolveWorktreeHome('/repo/wt', countingRunner);
  assert.deepEqual(first, { rootPath: '/repo/main', branch: 'feat' });
  const second = await resolveWorktreeHome('/repo/wt', countingRunner);
  assert.deepEqual(second, { rootPath: '/repo/main', branch: 'feat' });
  assert.equal(gitCalls, 1);

  clearWorktreeHomeCacheForTests();
  await resolveWorktreeHome('/repo/wt', countingRunner);
  assert.equal(gitCalls, 2);
});

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { getSessionSubtitle, getSessionWorktreeLabel } from '@/shared/utils';
import type { ProjectSession } from '@/shared/types';

function sessionWith(overrides: Partial<ProjectSession>): ProjectSession {
  return { id: 'ses_1', ...overrides };
}

test('getSessionWorktreeLabel prefers the branch name', () => {
  const label = getSessionWorktreeLabel(
    sessionWith({ worktreePath: '/repo/worktrees/feat-x', worktreeBranch: 'feat/x' }),
  );
  assert.equal(label, 'feat/x');
});

test('getSessionWorktreeLabel falls back to the worktree directory basename when detached', () => {
  const label = getSessionWorktreeLabel(
    sessionWith({ worktreePath: '/repo/worktrees/feat-x/', worktreeBranch: null }),
  );
  assert.equal(label, 'feat-x');
});

test('getSessionWorktreeLabel splits Windows backslash paths for the detached fallback', () => {
  const label = getSessionWorktreeLabel(
    sessionWith({ worktreePath: 'C:\\repo\\worktrees\\feat-x', worktreeBranch: null }),
  );
  assert.equal(label, 'feat-x');
});

test('getSessionWorktreeLabel returns null for a main-checkout session', () => {
  assert.equal(getSessionWorktreeLabel(sessionWith({ worktreePath: null, worktreeBranch: null })), null);
  assert.equal(getSessionWorktreeLabel(sessionWith({})), null);
  assert.equal(getSessionWorktreeLabel(null), null);
});

test('getSessionWorktreeLabel ignores blank metadata', () => {
  const label = getSessionWorktreeLabel(sessionWith({ worktreePath: '  ', worktreeBranch: '   ' }));
  assert.equal(label, null);
});

test('getSessionSubtitle appends the worktree label to the project name', () => {
  const subtitle = getSessionSubtitle(
    'MirLite',
    sessionWith({ worktreePath: '/repo/wt', worktreeBranch: 'feat/x' }),
  );
  assert.equal(subtitle, 'MirLite · feat/x');
});

test('getSessionSubtitle keeps the plain project name without a worktree', () => {
  const subtitle = getSessionSubtitle('MirLite', sessionWith({ worktreePath: null, worktreeBranch: null }));
  assert.equal(subtitle, 'MirLite');
});

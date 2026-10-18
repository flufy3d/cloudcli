import type { ProjectSession } from '@/shared/types';

/**
 * Worktree label shown next to a session's owning project in the workspace
 * header ("Project · branch").
 *
 * Prefers the branch name; for a detached worktree falls back to the worktree
 * directory's basename. Returns null for sessions running in their project's
 * main checkout, so the header keeps showing the plain project name.
 *
 * Used by WorkspaceTitle to render the session subtitle.
 */
export function getSessionWorktreeLabel(session: ProjectSession | null): string | null {
  if (!session) {
    return null;
  }

  const branch = typeof session.worktreeBranch === 'string' ? session.worktreeBranch.trim() : '';
  if (branch) {
    return branch;
  }

  const worktreePath = typeof session.worktreePath === 'string' ? session.worktreePath.trim() : '';
  if (!worktreePath) {
    return null;
  }

  // Server paths arrive normalized per-platform (Windows keeps backslashes),
  // so split on both separators before taking the last segment.
  const segments = worktreePath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? null;
}

/**
 * The full session subtitle: owning project name plus the worktree label when
 * the session runs in a worktree. Mirrors the "repo · branch" naming the
 * open-worktree-as-project flow uses, so both surfaces read the same.
 */
export function getSessionSubtitle(projectDisplayName: string, session: ProjectSession | null): string {
  const worktreeLabel = getSessionWorktreeLabel(session);
  return worktreeLabel ? `${projectDisplayName} · ${worktreeLabel}` : projectDisplayName;
}

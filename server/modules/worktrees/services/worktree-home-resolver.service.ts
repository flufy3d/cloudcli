import type { GitCommandResult, GitCommandRunner, WorktreeHome } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

import {
  findWorktreeEntryByPath,
  listWorktreePorcelainEntries,
  runGitCommand,
} from './worktree-git.service.js';

/**
 * Answers "which main checkout does this directory's worktree belong to?" for
 * the session worktree placement policy.
 *
 * Consumers: the providers module's session synchronizers (through the
 * placement policy in `providers/shared/sessions`). Sessions indexed with a
 * worktree directory get reunified under the main checkout's project, so the
 * lookup must be cheap enough to run on every synchronizer scan — hence the
 * per-directory TTL cache below (same pattern as `getProjectWorktreeRoots`).
 * Negative results are cached too: most session directories are plain
 * checkouts, and re-probing those on every scan would spawn a git process per
 * session per scan.
 */

const WORKTREE_HOME_CACHE_TTL_MS = 30_000;
type WorktreeHomeCacheEntry = { timestamp: number; home: WorktreeHome | null };
const worktreeHomeCache = new Map<string, WorktreeHomeCacheEntry>();

function isSamePath(left: string, right: string): boolean {
  const comparable = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return comparable(left) === comparable(right);
}

/**
 * Resolves the main checkout and branch for the git worktree at `directory`.
 *
 * Resolves to null — never throws — when the directory is the main worktree
 * itself, not inside a git repository, missing from disk, or otherwise not a
 * linked worktree. Results (including null) are cached per normalized
 * directory for `WORKTREE_HOME_CACHE_TTL_MS`.
 */
export async function resolveWorktreeHome(
  directory: string,
  runGit: GitCommandRunner = runGitCommand,
): Promise<WorktreeHome | null> {
  const normalizedPath = normalizeProjectPath(directory);
  const now = Date.now();
  const cached = worktreeHomeCache.get(normalizedPath);
  if (cached && now - cached.timestamp < WORKTREE_HOME_CACHE_TTL_MS) {
    return cached.home;
  }

  let home: WorktreeHome | null = null;
  try {
    const entries = await listWorktreePorcelainEntries(normalizedPath, runGit);
    const mainEntry = entries[0];
    const ownEntry = findWorktreeEntryByPath(entries, normalizedPath);
    if (!isSamePath(mainEntry.path, normalizedPath)) {
      home = {
        rootPath: mainEntry.path,
        branch: ownEntry.isDetached ? null : ownEntry.branch,
      };
    }
  } catch {
    home = null;
  }

  worktreeHomeCache.set(normalizedPath, { timestamp: now, home });
  return home;
}

/** Used by tests to clear the resolver cache between test runs. */
export function clearWorktreeHomeCacheForTests(): void {
  worktreeHomeCache.clear();
}

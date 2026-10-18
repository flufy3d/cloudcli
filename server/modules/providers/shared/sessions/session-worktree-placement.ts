/**
 * Session Worktree Placement
 *
 * Single policy deciding which CloudCLI project a discovered session belongs
 * to when its recorded directory is a git worktree. Engines with their own
 * worktree feature (OpenCode today) rebind an existing session's directory to
 * a worktree mid-conversation; naive directory-keyed indexing then files the
 * session under a brand-new phantom project named after the worktree folder.
 *
 * This policy reunifies such sessions under the main checkout's registered
 * project and hands back the worktree metadata for the workspace header's
 * branch label. It deliberately keeps sessions that already live under a
 * deliberately-named worktree project (the "open worktree as project" flow
 * names them "repo · branch"), and it never moves a session when the main
 * checkout has no active project row of its own.
 *
 * Every session synchronizer — the SQLite skeleton (antigravity, zcode,
 * opencode) and the file-scanning indexers (claude, codex, cursor) — asks this
 * right before `sessionsDb.createSession`, so one rule covers all engines
 * instead of each indexer growing its own workaround.
 *
 * @module session-worktree-placement
 */

import { projectsDb } from '@/modules/database/index.js';
import type { SessionWorktreeInfo, WorktreeHomeResolver } from '@/shared/types.js';
import { isDefaultProjectDisplayName, normalizeProjectPath } from '@/shared/utils.js';

export type SessionWorktreePlacement = {
  /** Owning project path the session row should be keyed under. */
  projectPath: string;
  /** Worktree the session runs in; null when it stays in a main checkout. */
  worktree: SessionWorktreeInfo | null;
};

/**
 * The production git lookup, registered by the server composition root via
 * `setSessionWorktreeHomeResolver`.
 *
 * Injected instead of statically imported on purpose: the Worktrees barrel
 * transitively pulls in the projects and providers barrels, and a static edge
 * from this module (which the session synchronizer base class loads) would
 * close an initialization cycle through `SqliteSessionSynchronizer` and crash
 * module evaluation.
 */
let configuredWorktreeHomeResolver: WorktreeHomeResolver | null = null;

let hasWarnedAboutMissingResolver = false;

/** Used by the server entrypoint to wire the Worktrees module's cached git resolver. */
export function setSessionWorktreeHomeResolver(resolver: WorktreeHomeResolver | null): void {
  configuredWorktreeHomeResolver = resolver;
}

/**
 * Resolves the project placement for one discovered session directory.
 *
 * `resolveHome` is injectable so tests can stub the git lookup; production
 * callers omit it and get the resolver registered at composition time. Without
 * any resolver the placement is a no-op and sessions keep today's
 * directory-keyed behavior — warned about once so a forgotten wiring cannot
 * silently disable the reunification.
 */
export async function applySessionWorktreePlacement(
  projectPath: string,
  resolveHome?: WorktreeHomeResolver,
): Promise<SessionWorktreePlacement> {
  const normalizedPath = normalizeProjectPath(projectPath);
  const stay: SessionWorktreePlacement = { projectPath: normalizedPath, worktree: null };

  const homeResolver = resolveHome ?? configuredWorktreeHomeResolver;
  if (!homeResolver) {
    if (!hasWarnedAboutMissingResolver) {
      hasWarnedAboutMissingResolver = true;
      console.warn(
        '[SessionWorktreePlacement] No worktree home resolver registered; sessions stay keyed by their raw directory',
      );
    }
    return stay;
  }

  const home = await homeResolver(normalizedPath);
  if (!home) {
    return stay;
  }

  const mainProjectRow = projectsDb.getProjectPath(home.rootPath);
  if (!mainProjectRow || mainProjectRow.isArchived) {
    return stay;
  }

  const worktreeProjectRow = projectsDb.getProjectPath(normalizedPath);
  if (worktreeProjectRow && !isDefaultProjectDisplayName(worktreeProjectRow.custom_project_name, normalizedPath)) {
    return stay;
  }

  return {
    projectPath: home.rootPath,
    worktree: { path: normalizedPath, branch: home.branch },
  };
}

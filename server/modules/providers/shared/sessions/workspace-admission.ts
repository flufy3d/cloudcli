/**
 * Workspace Admission
 *
 * Single gate deciding whether a workspace path discovered inside engine
 * storage may become a CloudCLI project. Every session synchronizer — the
 * SQLite skeleton (antigravity, zcode, opencode) and the file-scanning
 * indexers (claude, codex, cursor) — asks this before calling
 * `sessionsDb.createSession`, so one rule covers all engines instead of each
 * indexer growing its own filter.
 *
 * @module workspace-admission
 */

import fsSync from 'node:fs';

import { projectsDb } from '@/modules/database/index.js';
import { isInfrastructureWorkspacePath } from '@/shared/utils.js';

/**
 * Decides whether sessions recorded against `projectPath` may be indexed.
 *
 * Two rejection rules, both aimed at directories that are runtime artifacts
 * rather than places the user works:
 *
 * 1. Package-manager and runtime internals (`node_modules`, pnpm's `.pnpm`
 *    virtual store) — see `isInfrastructureWorkspacePath`.
 * 2. A directory that no longer exists **and** was never registered as a
 *    project. An engine invoked inside a `mktemp -d` sandbox records that
 *    sandbox as its workspace; once the system reaps the directory, the
 *    engine's own session index still names it, so every restart used to
 *    resurrect the same ghost projects — including ones the user had just
 *    deleted.
 *
 * The "and was never registered" half is what keeps this from repeating the
 * mistake 1ff5a900 fixed: a temp root is not disqualifying by itself (a
 * scratch clone or bug repro there is real work), and an existing project row
 * whose volume is merely unmounted keeps syncing. Rejection only ever blocks
 * creating a project, never removes one.
 *
 * Consumers: the SQLite session synchronizer skeleton and the claude, codex,
 * and cursor session synchronizers.
 */
export function admitsWorkspacePath(projectPath: string): boolean {
  if (isInfrastructureWorkspacePath(projectPath)) {
    return false;
  }

  if (fsSync.existsSync(projectPath)) {
    return true;
  }

  return projectsDb.getProjectPath(projectPath) !== null;
}

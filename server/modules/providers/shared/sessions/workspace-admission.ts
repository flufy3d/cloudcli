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
import { isInfrastructureWorkspacePath, isSystemTemporaryWorkspacePath } from '@/shared/utils.js';

/**
 * Decides whether sessions recorded against `projectPath` may be indexed.
 *
 * Three rejection rules, all aimed at directories that are runtime artifacts
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
 * 3. Anything inside the operating system's temporary directories. Engine
 *    runtimes stage scratch work there (task review sandboxes, test
 *    fixtures), and those runs used to land in the sidebar as projects; the
 *    directories stay out of project indexing entirely. The sessions and
 *    their engine-side records are untouched — only CloudCLI's own project
 *    row and its sidebar visibility are affected.
 *
 * The "and was never registered" half is what keeps an unmounted volume or a
 * detached network share syncing: an existing project row whose directory is
 * merely absent keeps updating. Rejection only ever blocks creating a
 * project, never removes one.
 *
 * Consumers: the SQLite session synchronizer skeleton and the claude, codex,
 * and cursor session synchronizers.
 */
export function admitsWorkspacePath(projectPath: string): boolean {
  if (isInfrastructureWorkspacePath(projectPath) || isSystemTemporaryWorkspacePath(projectPath)) {
    return false;
  }

  if (fsSync.existsSync(projectPath)) {
    return true;
  }

  return projectsDb.getProjectPath(projectPath) !== null;
}

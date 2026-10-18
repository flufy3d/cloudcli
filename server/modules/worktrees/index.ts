// worktreesRoutes: used by the server entrypoint to mount the complete Worktrees HTTP API at `/api/worktrees`.
export { worktreesRoutes } from './worktrees.module.js';

// getProjectWorktreeRoots: used by File Tree to resolve dynamic worktree read-only roots for a project.
export { getProjectWorktreeRoots } from './services/worktree-git.service.js';

// resolveWorktreeHome: used by the session worktree placement policy to reunify engine sessions
// that an engine rebound into one of the repository's worktrees.
export { resolveWorktreeHome } from './services/worktree-home-resolver.service.js';

import { BackgroundWorkRegistry } from '../../shared/background-work/background-work-registry.js';

/**
 * Codex agents still running, keyed by app session id and agent thread id.
 *
 * Fed by the runtime from the `SubAgentActivity` records of the turn in flight
 * and emptied when that turn ends: the app-server is a child process that
 * `connection.close()` kills at the end of every turn, and its agents die
 * with it. Read by the runtime's `listBackgroundWork()` and by the sessions
 * provider, which uses it to tell an agent that is genuinely still running
 * (its turn is in flight) from one whose rollout simply has no end record.
 *
 * Process-wide by design: an agent nobody here tracks cannot be running.
 */
export const codexBackgroundWork = new BackgroundWorkRegistry();

/** The `taskType` Codex's spawned agents report as. */
export const CODEX_BACKGROUND_TASK_TYPE = 'collab_agent';

import { BackgroundWorkRegistry } from '../../shared/background-work/background-work-registry.js';

/**
 * ZCode agents still running, keyed by app session id and agent id.
 *
 * Fed by the runtime from the engine's `subagent_spawned`/`subagent_stopped`
 * events; read by the runtime's `listBackgroundWork()` and by the sessions
 * provider, which uses it to tell an agent that is genuinely still running
 * from one the engine's sidecar still calls running because the process that
 * ran it died before it could report.
 *
 * Process-wide by design: the ZCode engine is this server's child process, so
 * an agent nobody here tracks cannot be running anywhere.
 */
export const zcodeBackgroundWork = new BackgroundWorkRegistry();

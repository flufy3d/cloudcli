// diagnosticsRoutes: used by the server entrypoint to mount the authenticated
// diagnostics API at `/api/diagnostics`, which serves the run-outcome log to
// the settings export.
export { default as diagnosticsRoutes } from '@/modules/diagnostics/diagnostics.routes.js';

// recordRunOutcome: used by the websocket module's run registry to record why
// each run ended, which is what tells a client abort apart from an engine that
// died on its own.
export { recordRunOutcome } from '@/modules/diagnostics/services/run-outcome-log.service.js';

// readRunOutcomes / clearRunOutcomes: used by the websocket module's tests to
// assert that every engine's runs are classified identically, and to start each
// case from an empty log.
export {
  clearRunOutcomes,
  readRunOutcomes,
} from '@/modules/diagnostics/services/run-outcome-log.service.js';

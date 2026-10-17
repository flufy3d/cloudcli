import { appConfigDb } from '@/modules/database/index.js';

export const TASK_CONTINUATIONS_ENABLED_CONFIG_KEY = 'async_task_continuations_enabled';

/** Task reporting and automatic continuation stay disabled until an administrator enables them. */
export function areTaskContinuationsEnabled(): boolean {
  return appConfigDb.get(TASK_CONTINUATIONS_ENABLED_CONFIG_KEY) === 'true';
}

/** Persists the process-wide switch used by new background dispatches. */
export function setTaskContinuationsEnabled(enabled: boolean): void {
  appConfigDb.set(TASK_CONTINUATIONS_ENABLED_CONFIG_KEY, String(enabled));
}

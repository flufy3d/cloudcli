import os from 'node:os';
import path from 'node:path';

const TASK_ROOT_ENV = 'CLOUDCLI_TASKS_DIR';

/** Returns the configured task output root shared by workers and recovery scans. */
export function getTaskContinuationTasksRoot(): string {
  return path.resolve(process.env[TASK_ROOT_ENV] || path.join(os.homedir(), '.cloudcli', 'tasks'));
}

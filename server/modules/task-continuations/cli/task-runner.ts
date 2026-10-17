export type ParsedTaskRunnerArgs = {
  command: 'run' | 'status' | 'cancel-notification' | 'retry-notification' | 'continuation-config' | 'help';
  title?: string;
  autoNotify?: boolean;
  taskId?: string;
  taskCommand?: string[];
  confirmMayDuplicate?: boolean;
  reason?: string;
  enabled?: boolean;
  invalidEnabled?: boolean;
};

async function requestTaskApi(input: {
  env: NodeJS.ProcessEnv;
  apiUrl: string;
  path: string;
  method?: string;
  body?: Record<string, unknown>;
  missingTokenMessage: string;
  failureMessage: string;
}): Promise<number> {
  const userToken = input.env.CLOUDCLI_USER_TOKEN;
  if (!userToken) {
    console.error(input.missingTokenMessage);
    return 1;
  }
  try {
    const response = await fetch(`${input.apiUrl}${input.path}`, {
      method: input.method ?? 'GET',
      headers: {
        authorization: `Bearer ${userToken}`,
        ...(input.env.CLOUDCLI_API_KEY ? { 'x-api-key': input.env.CLOUDCLI_API_KEY } : {}),
        ...(input.body || input.method === 'POST' || input.method === 'PUT' ? { 'content-type': 'application/json' } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
    return response.ok ? 0 : 1;
  } catch (error) {
    console.error(`${input.failureMessage}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * Parses command line arguments for the task runner CLI.
 *
 * Consumed by task runner CLI entry point and unit tests.
 */
export function parseTaskRunnerArgs(argv: string[]): ParsedTaskRunnerArgs {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command === 'status') {
    const taskIndex = rest.indexOf('--task');
    const taskId = taskIndex !== -1 && rest[taskIndex + 1] ? rest[taskIndex + 1] : undefined;
    return { command: 'status', taskId };
  }

  if (command === 'cancel-notification') {
    const taskIndex = rest.indexOf('--task');
    const taskId = taskIndex !== -1 && rest[taskIndex + 1] ? rest[taskIndex + 1] : undefined;
    return { command: 'cancel-notification', taskId };
  }

  if (command === 'retry-notification') {
    const taskIndex = rest.indexOf('--task');
    const reasonIndex = rest.indexOf('--reason');
    const taskId = taskIndex !== -1 && rest[taskIndex + 1] ? rest[taskIndex + 1] : undefined;
    const reason = reasonIndex !== -1 && rest[reasonIndex + 1] ? rest.slice(reasonIndex + 1).join(' ') : undefined;
    return {
      command: 'retry-notification', taskId, reason,
      confirmMayDuplicate: rest.includes('--confirm-may-duplicate'),
    };
  }

  if (command === 'continuation-config') {
    const enabledIndex = rest.indexOf('--enabled');
    const value = enabledIndex === -1 ? undefined : rest[enabledIndex + 1];
    return {
      command: 'continuation-config',
      ...(value === 'true' ? { enabled: true } : value === 'false' ? { enabled: false } : {}),
      invalidEnabled: enabledIndex !== -1 && value !== 'true' && value !== 'false',
    };
  }

  if (command === 'run') {
    let title = '后台异步任务';
    let autoNotify = false;
    let taskCommand: string[] = [];

    const delimiterIndex = rest.indexOf('--');
    const flags = delimiterIndex !== -1 ? rest.slice(0, delimiterIndex) : rest;
    taskCommand = delimiterIndex !== -1 ? rest.slice(delimiterIndex + 1) : [];

    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--title' && flags[i + 1]) {
        title = flags[i + 1];
        i++;
      } else if (flags[i] === '--notify') {
        autoNotify = true;
      }
    }

    return {
      command: 'run',
      title,
      autoNotify,
      taskCommand,
    };
  }

  return { command: 'help' };
}

/**
 * Main execution handler for the task runner CLI.
 *
 * Consumed by CLI execution and test suite.
 */
export async function runMainTaskRunner(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const parsed = parseTaskRunnerArgs(argv);

  if (parsed.command === 'help') {
    console.log(`CloudCLI Background Task Runner

Usage:
  node "$HOME/.cloudcli/runtime/node_modules/cloudcli/dist-server/server/modules/task-continuations/cli/task-runner.js" status --task <taskId>
  node "$HOME/.cloudcli/runtime/node_modules/cloudcli/dist-server/server/modules/task-continuations/cli/task-runner.js" cancel-notification --task <taskId>
  node "$HOME/.cloudcli/runtime/node_modules/cloudcli/dist-server/server/modules/task-continuations/cli/task-runner.js" retry-notification --task <taskId> --confirm-may-duplicate --reason <reason>
  node "$HOME/.cloudcli/runtime/node_modules/cloudcli/dist-server/server/modules/task-continuations/cli/task-runner.js" continuation-config [--enabled true|false]
  Set CLOUDCLI_USER_TOKEN to a CloudCLI user JWT; set CLOUDCLI_API_KEY when the server requires an API key.
`);
    return 0;
  }

  const apiUrl = env.CLOUDCLI_API_URL || `http://localhost:${env.PORT || '3030'}`;

  if (parsed.command === 'continuation-config') {
    if (parsed.invalidEnabled) {
      console.error('[TaskRunner] Error: --enabled must be true or false.');
      return 1;
    }
    return requestTaskApi({
      env,
      apiUrl,
      path: '/api/tasks/config/continuations',
      method: parsed.enabled === undefined ? 'GET' : 'PUT',
      ...(parsed.enabled === undefined ? {} : { body: { enabled: parsed.enabled } }),
      missingTokenMessage: '[TaskRunner] Error: CLOUDCLI_USER_TOKEN is required for task management.',
      failureMessage: '[TaskRunner] Failed to update continuation configuration',
    });
  }

  if (parsed.command === 'status') {
    if (!parsed.taskId) {
      console.error('[TaskRunner] Error: --task <taskId> is required for status check.');
      return 1;
    }
    return requestTaskApi({
      env,
      apiUrl,
      path: `/api/tasks/${encodeURIComponent(parsed.taskId)}`,
      missingTokenMessage: '[TaskRunner] Failed to fetch task status: CLOUDCLI_USER_TOKEN is required for task management.',
      failureMessage: '[TaskRunner] Failed to fetch task status',
    });
  }

  if (parsed.command === 'cancel-notification') {
    if (!parsed.taskId) {
      console.error('[TaskRunner] Error: --task <taskId> is required for cancel-notification.');
      return 1;
    }
    return requestTaskApi({
      env,
      apiUrl,
      path: `/api/tasks/${encodeURIComponent(parsed.taskId)}/cancel-notification`,
      method: 'POST',
      missingTokenMessage: '[TaskRunner] Failed to cancel task notification: CLOUDCLI_USER_TOKEN is required for task management.',
      failureMessage: '[TaskRunner] Failed to cancel task notification',
    });
  }

  if (parsed.command === 'retry-notification') {
    if (!parsed.taskId || !parsed.confirmMayDuplicate || !parsed.reason?.trim()) {
      console.error('[TaskRunner] Error: retry-notification requires --task, --confirm-may-duplicate, and --reason.');
      return 1;
    }
    return requestTaskApi({
      env,
      apiUrl,
      path: `/api/tasks/${encodeURIComponent(parsed.taskId)}/retry-notification`,
      method: 'POST',
      body: { confirmMayDuplicate: true, reason: parsed.reason.slice(0, 500) },
      missingTokenMessage: '[TaskRunner] Error: CLOUDCLI_USER_TOKEN is required for task management.',
      failureMessage: '[TaskRunner] Failed to retry task notification',
    });
  }

  if (parsed.command === 'run') {
    console.error('[TaskRunner] External command execution is disabled. Use the sandboxed cloudcli_task_run tool from its chat.');
    return 1;
  }

  return 1;
}

// When executed directly from node CLI, dispatch arguments
if (process.argv[1] && /task-runner\.(?:js|ts)$/.test(process.argv[1])) {
  runMainTaskRunner(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error('[TaskRunner] Fatal error:', err);
    process.exit(1);
  });
}

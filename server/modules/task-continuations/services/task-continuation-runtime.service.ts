import { access, constants, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { userDb } from '@/modules/database/index.js';
import { areTaskContinuationsEnabled } from '@/modules/task-continuations/task-continuations.config.js';
import { createCodexTaskHistoryChecker } from '@/modules/task-continuations/services/task-continuation-history.service.js';
import { startTaskContinuationWorker } from '@/modules/task-continuations/services/task-continuation-dispatcher.service.js';
import { reconcileIncompleteContinuationEvents, scanAndRecoverTaskResultsFromDisk } from '@/modules/task-continuations/services/task-continuation-recovery.service.js';
import type { TaskContinuationTargetCheck } from '@/shared/types.js';

export async function validateTaskContinuationTarget(input: {
  runtime: Pick<ProviderRuntimeGateway, 'hasRuntime' | 'hasBackgroundWork'>;
  userId: number;
  sessionId: string;
  provider: string;
  sessionProjectPath: string;
  workingDirectory: string;
}): Promise<TaskContinuationTargetCheck> {
  if (!userDb.getUserById(input.userId)) {
    return { outcome: 'invalid', reason: 'The task owner is no longer active.' };
  }
  if (!input.runtime.hasRuntime(input.provider)) {
    return { outcome: 'invalid', reason: `Provider "${input.provider}" is no longer available.` };
  }

  try {
    const projectPath = await realpath(input.sessionProjectPath);
    const workingDirectory = await realpath(input.workingDirectory);
    const projectInfo = await stat(projectPath);
    const workingDirectoryInfo = await stat(workingDirectory);
    if (!projectInfo.isDirectory() || !workingDirectoryInfo.isDirectory()) {
      return { outcome: 'invalid', reason: 'The original project or working directory is no longer a directory.' };
    }
    await access(projectPath, constants.R_OK | constants.X_OK);
    await access(workingDirectory, constants.R_OK | constants.X_OK);
    const relative = path.relative(projectPath, workingDirectory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { outcome: 'invalid', reason: 'The original working directory is outside the project directory.' };
    }
  } catch {
    return { outcome: 'invalid', reason: 'The original project or working directory is no longer accessible.' };
  }

  if (input.runtime.hasBackgroundWork(input.sessionId)) {
    return { outcome: 'busy', reason: 'The original conversation still has engine background work.' };
  }
  return { outcome: 'ready' };
}

/** Recovers disk results, reconciles Codex history, and starts task dispatch/reconciliation timers. */
export async function startTaskContinuationRuntime(input: {
  runtime: ProviderRuntimeGateway;
  pollIntervalMs?: number;
  historyIntervalMs?: number;
}): Promise<{ stop: () => void }> {
  const { runDetachedChatTurn } = await import('@/modules/websocket/index.js');
  const historyChecker = createCodexTaskHistoryChecker();
  await scanAndRecoverTaskResultsFromDisk();
  await reconcileIncompleteContinuationEvents({ historyChecker });

  return startTaskContinuationWorker({
    recoverPendingTasks: () => scanAndRecoverTaskResultsFromDisk(),
    validateTarget: ({ task, session }) => validateTaskContinuationTarget({
      runtime: input.runtime,
      userId: task.user_id,
      sessionId: session.session_id,
      provider: session.provider,
      sessionProjectPath: task.session_project_path!,
      workingDirectory: task.working_directory!,
    }),
    runner: async (params) => {
      const runResult = await runDetachedChatTurn({
        sessionId: params.sessionId,
        userId: params.userId,
        content: '',
        interruptActiveRun: false,
        taskContinuation: {
          eventId: params.eventId,
          attemptId: params.attemptId,
          taskId: params.taskId,
          status: params.status,
          summary: params.summary,
          exitCode: params.exitCode,
          resultJson: params.resultJson,
        },
        taskContinuationTarget: {
          providerThreadId: params.providerThreadId,
          sessionProjectPath: params.sessionProjectPath,
          workingDirectory: params.workingDirectory,
          sandboxPolicyType: params.sandboxPolicyType,
          networkAccess: params.networkAccess,
          approvalPolicy: params.approvalPolicy,
        },
        onEngineTurnStarted: params.onEngineTurnStarted,
      }, { runtime: input.runtime });
      if (runResult.busy) {
        return { outcome: 'busy', error: runResult.error };
      }
      return {
        outcome: 'terminal',
        success: runResult.started && !runResult.error
          && runResult.terminalStatus === 'completed'
          && Boolean(runResult.engineTurnId),
        engineTurnId: runResult.engineTurnId,
        terminalStatus: runResult.terminalStatus ?? 'unknown',
        error: runResult.error,
      };
    },
    shouldDispatch: areTaskContinuationsEnabled,
    pollIntervalMs: input.pollIntervalMs,
    historyIntervalMs: input.historyIntervalMs,
    reconcileAccepted: (activeEventIds) => reconcileIncompleteContinuationEvents({
      historyChecker,
      includeSending: false,
      excludedEventIds: activeEventIds,
    }),
  });
}

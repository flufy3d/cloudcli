import crypto from 'node:crypto';
import path from 'node:path';

import { sessionsDb, taskContinuationDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type {
  AsyncTaskRecord,
  TaskContinuationEventRecord,
  TaskContinuationTargetCheck,
} from '@/shared/types.js';

export type TaskContinuationTargetValidator = (input: {
  task: AsyncTaskRecord;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
}) => Promise<TaskContinuationTargetCheck>;

export type TaskContinuationRunnerResult =
  | { outcome: 'busy'; error?: string | null }
  | {
      outcome?: 'terminal';
      success: boolean;
      engineTurnId?: string | null;
      terminalStatus: 'completed' | 'failed' | 'interrupted' | 'unknown';
      error?: string | null;
    };

export type TaskContinuationRunner = (params: {
  sessionId: string;
  taskId: string;
  userId: number;
  eventId: string;
  attemptId: string;
  status: string;
  summary: string;
  exitCode: number | null;
  resultJson: string | null;
  providerThreadId: string;
  sessionProjectPath: string;
  workingDirectory: string;
  sandboxPolicyType: 'workspaceWrite' | 'dangerFullAccess';
  networkAccess: boolean;
  approvalPolicy: 'never' | 'on-request';
  onEngineTurnStarted: (engineTurnId: string) => boolean;
}) => Promise<TaskContinuationRunnerResult>;

function markNeedsReview(
  event: TaskContinuationEventRecord,
  error: string,
): boolean {
  const common = { eventId: event.event_id, error, terminalStatus: 'needs_review' as const };
  switch (event.status) {
    case 'pending':
      return taskContinuationDb.updateEventFailed({ ...common, expectedStatus: 'pending' });
    case 'claimed':
      return taskContinuationDb.updateEventFailed({
        ...common,
        expectedStatus: 'claimed',
        leaseOwner: event.lease_owner,
      });
    case 'sending':
    case 'uncertain':
      return taskContinuationDb.updateEventFailed({
        ...common,
        expectedStatus: event.status,
        hostRunId: event.host_run_id,
      });
    case 'accepted':
      return taskContinuationDb.updateEventFailed({
        ...common,
        expectedStatus: 'accepted',
        engineTurnId: event.engine_turn_id,
      });
    default:
      return false;
  }
}

/**
 * Dispatches one continuation event while guaranteeing non-preemptive session occupancy.
 *
 * If the target session is currently busy with user activity or active background work,
 * the dispatcher politely yields the lease back to pending instead of interrupting the user.
 *
 * Consumed by task continuation poll loops, completion triggers, and recovery routines.
 */
export async function dispatchTaskContinuationEvent(input: {
  eventId: string;
  leaseOwner: string;
  runner: TaskContinuationRunner;
  validateTarget?: TaskContinuationTargetValidator;
}): Promise<boolean> {
  const event = taskContinuationDb.getEventById(input.eventId);
  if (!event) {
    return false;
  }

  const task = taskContinuationDb.getTaskById(event.task_id);
  if (!task) {
    markNeedsReview(event, `Associated task ${event.task_id} not found`);
    return false;
  }

  // 1. 如果事件尚未由本 Dispatcher 领取，先原子认领
  if (event.status === 'pending' || (event.status === 'claimed' && event.lease_owner !== input.leaseOwner)) {
    const claimed = taskContinuationDb.claimEventById({
      eventId: event.event_id,
      leaseOwner: input.leaseOwner,
      leaseDurationMs: 30_000,
    });
    if (!claimed) {
      return false;
    }
  }

  // 2. 检查目标会话是否处于运行中（用户交互优先，绝不打断）
  if (chatRunRegistry.isProcessing(event.session_id)) {
    taskContinuationDb.releaseClaimedEvent({
      eventId: event.event_id,
      leaseOwner: input.leaseOwner,
    });
    return false;
  }

  const claimedEvent = taskContinuationDb.getEventById(event.event_id);
  if (!claimedEvent || claimedEvent.status !== 'claimed' || claimedEvent.lease_owner !== input.leaseOwner) {
    return false;
  }
  const targetSession = sessionsDb.getSessionById(event.session_id);
  if (targetSession?.isArchived) {
    taskContinuationDb.releaseClaimedEvent({ eventId: event.event_id, leaseOwner: input.leaseOwner });
    return false;
  }
  if (!targetSession
    || targetSession.provider !== 'codex'
    || !task.provider_thread_id
    || targetSession.provider_session_id !== task.provider_thread_id
    || !targetSession.project_path
    || !task.session_project_path
    || path.resolve(targetSession.project_path) !== path.resolve(task.session_project_path)
    || !task.working_directory
    || !path.isAbsolute(task.working_directory)
    || !task.sandbox_policy_type
    || task.network_access === null
    || !task.approval_policy) {
    markNeedsReview(claimedEvent, 'The original conversation or execution permission snapshot is missing or has changed.');
    return false;
  }

  if (input.validateTarget) {
    const targetCheck = await input.validateTarget({ task, session: targetSession });
    if (targetCheck.outcome === 'busy') {
      taskContinuationDb.releaseClaimedEvent({ eventId: event.event_id, leaseOwner: input.leaseOwner });
      return false;
    }
    if (targetCheck.outcome === 'invalid') {
      markNeedsReview(claimedEvent, targetCheck.reason);
      return false;
    }
  }

  // 3. 标记进入 sending 状态，记录宿主尝试 runId
  const hostRunId = `run_${crypto.randomUUID()}`;
  const sendingUpdated = taskContinuationDb.updateEventSending({
    eventId: event.event_id,
    leaseOwner: input.leaseOwner,
    hostRunId,
  });

  if (!sendingUpdated) {
    // 租约可能已被接管或状态已改变
    return false;
  }

  let acceptedEngineTurnId: string | null = null;
  const acceptEngineTurn = (engineTurnId: string): boolean => {
    if (acceptedEngineTurnId) return acceptedEngineTurnId === engineTurnId;
    const accepted = taskContinuationDb.updateEventAccepted({
      eventId: event.event_id,
      engineTurnId,
      hostRunId,
    });
    if (accepted) acceptedEngineTurnId = engineTurnId;
    return accepted;
  };

  // 3. 执行真实接续
  try {
    const runResult = await input.runner({
      sessionId: event.session_id,
      taskId: task.task_id,
      userId: task.user_id,
      eventId: event.event_id,
      attemptId: hostRunId,
      status: task.status,
      summary: task.result_summary || '异步任务执行完成',
      exitCode: task.exit_code,
      resultJson: task.result_json,
      providerThreadId: task.provider_thread_id,
      sessionProjectPath: task.session_project_path,
      workingDirectory: task.working_directory,
      sandboxPolicyType: task.sandbox_policy_type,
      networkAccess: task.network_access === 1,
      approvalPolicy: task.approval_policy,
      onEngineTurnStarted: acceptEngineTurn,
    });

    if (runResult.outcome === 'busy') {
      if (acceptedEngineTurnId) {
        taskContinuationDb.updateEventFailed({
          eventId: event.event_id,
          error: 'The gateway reported busy after the engine accepted a continuation.',
          terminalStatus: 'needs_review',
          expectedStatus: 'accepted',
          engineTurnId: acceptedEngineTurnId,
        });
        return false;
      }
      taskContinuationDb.releaseSendingEvent({
        eventId: event.event_id,
        hostRunId,
        reason: runResult.error || 'The target chat became busy before the engine accepted the turn.',
      });
      return false;
    }

    if (runResult.engineTurnId && !acceptEngineTurn(runResult.engineTurnId)) {
      return false;
    }
    const engineTurnId = acceptedEngineTurnId;
    if (engineTurnId) {
      if (runResult.engineTurnId && runResult.engineTurnId !== engineTurnId) {
        taskContinuationDb.updateEventFailed({
          eventId: event.event_id,
          error: 'Codex returned a different turn id after accepting the continuation.',
          terminalStatus: 'needs_review',
          expectedStatus: 'accepted',
          engineTurnId,
        });
        return false;
      }
      if (runResult.success && runResult.terminalStatus === 'completed') {
        return taskContinuationDb.updateEventDelivered({
          eventId: event.event_id,
          engineTurnId,
        });
      }
      taskContinuationDb.updateEventFailed({
        eventId: event.event_id,
        error: runResult.error || `Engine turn ended with status ${runResult.terminalStatus}.`,
        terminalStatus: runResult.terminalStatus === 'unknown' ? 'needs_review' : 'reply_failed',
        expectedStatus: 'accepted',
        engineTurnId,
      });
      return false;
    }

    taskContinuationDb.updateEventFailed({
      eventId: event.event_id,
      error: runResult.error || (runResult.success && runResult.terminalStatus === 'completed'
        ? 'Engine did not return the accepted turn id.'
        : `Engine turn ended with status ${runResult.terminalStatus}.`),
      terminalStatus: 'needs_review',
      expectedStatus: 'sending',
      hostRunId,
    });
    return false;
  } catch (err: any) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    taskContinuationDb.updateEventFailed({
      eventId: event.event_id,
      error: errorMessage,
      terminalStatus: 'needs_review',
      expectedStatus: acceptedEngineTurnId ? 'accepted' : 'sending',
      ...(acceptedEngineTurnId ? { engineTurnId: acceptedEngineTurnId } : { hostRunId }),
    });
    return false;
  }
}

/**
 * Polls the queue for the next pending event and attempts to dispatch it.
 *
 * Consumed by background polling worker and immediate completion wakeups.
 */
export async function pollAndDispatchNextEvent(input: {
  leaseOwner: string;
  leaseDurationMs?: number;
  runner: TaskContinuationRunner;
  validateTarget?: TaskContinuationTargetValidator;
}): Promise<boolean> {
  const event = taskContinuationDb.claimPendingEvent({
    leaseOwner: input.leaseOwner,
    leaseDurationMs: input.leaseDurationMs ?? 30_000,
  });

  if (!event) {
    return false;
  }

  return dispatchTaskContinuationEvent({
    eventId: event.event_id,
    leaseOwner: input.leaseOwner,
    runner: input.runner,
    validateTarget: input.validateTarget,
  });
}

/**
 * Starts the background polling worker for async task continuation outbox.
 *
 * Consumed by server index bootstrap.
 */
export function startTaskContinuationWorker(dependencies: {
  runner: TaskContinuationRunner;
  pollIntervalMs?: number;
  shouldDispatch?: () => boolean;
  recoverPendingTasks?: () => Promise<unknown>;
  validateTarget?: TaskContinuationTargetValidator;
  reconcileAccepted?: (activeEventIds: ReadonlySet<string>) => Promise<void>;
  historyIntervalMs?: number;
}): { stop: () => void } {
  const interval = dependencies.pollIntervalMs ?? 5000;
  const activeEventIds = new Set<string>();
  let recoveringResults = false;
  const timer = setInterval(async () => {
    if (dependencies.recoverPendingTasks && !recoveringResults) {
      recoveringResults = true;
      try {
        await dependencies.recoverPendingTasks();
      } catch (err) {
        console.error('[TaskContinuationWorker] Result recovery scan failed:', err);
      } finally {
        recoveringResults = false;
      }
    }
    if (dependencies.shouldDispatch && !dependencies.shouldDispatch()) return;
    try {
      await pollAndDispatchNextEvent({
        leaseOwner: `dispatcher_${process.pid}`,
        leaseDurationMs: 30_000,
        validateTarget: dependencies.validateTarget,
        runner: async (params) => {
          activeEventIds.add(params.eventId);
          try {
            return await dependencies.runner(params);
          } finally {
            activeEventIds.delete(params.eventId);
          }
        },
      });
    } catch (err) {
      console.error('[TaskContinuationWorker] Polling failure:', err);
    }
  }, interval);

  timer.unref?.();

  let reconciling = false;
  const historyTimer = dependencies.reconcileAccepted
    ? setInterval(async () => {
      if (reconciling) return;
      reconciling = true;
      try {
        await dependencies.reconcileAccepted?.(new Set(activeEventIds));
      } catch (err) {
        console.error('[TaskContinuationWorker] History reconciliation failure:', err);
      } finally {
        reconciling = false;
      }
    }, dependencies.historyIntervalMs ?? 15_000)
    : null;
  historyTimer?.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
      if (historyTimer) clearInterval(historyTimer);
    },
  };
}

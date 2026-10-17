import path from 'node:path';

import express from 'express';
import type { Request, Response } from 'express';

import { authenticateToken } from '@/modules/auth/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  handleCancelTaskNotification,
  handleGetTaskStatus,
  handleManualRetryTaskNotification,
  handleTaskFinishRequest,
} from '@/modules/task-continuations/task-continuations.service.js';
import {
  areTaskContinuationsEnabled,
  setTaskContinuationsEnabled,
} from '@/modules/task-continuations/task-continuations.config.js';
import {
  readTaskOutputForScope,
  registerAndStartTaskFromRun,
} from '@/modules/task-continuations/services/task-continuation-worker-manager.service.js';
import { getTaskContinuationStatusHint } from '@/modules/task-continuations/services/task-continuation-status.service.js';
import type { TaskContinuationStatusHint } from '@/modules/task-continuations/services/task-continuation-status.service.js';
import { resolveTaskRunCapability } from '@/modules/task-continuations/services/task-run-context.service.js';
import type { AsyncTaskRecord, TaskContinuationEventRecord } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value.trim();
}

function readTaskRunCapability(request: Request) {
  const authorization = request.headers.authorization;
  const match = typeof authorization === 'string' ? /^Bearer\s+(trc_[A-Za-z0-9_-]+)$/.exec(authorization) : null;
  const context = match ? resolveTaskRunCapability(match[1]) : null;
  if (!context) {
    throw new AppError('Task run capability is invalid or expired.', {
      code: 'TASK_RUN_CONTEXT_INVALID',
      statusCode: 401,
    });
  }
  return { context, token: match![1] };
}

function readTaskRunContext(request: Request) {
  return readTaskRunCapability(request).context;
}

function toPublicTaskStatus(
  task: AsyncTaskRecord,
  continuationEvent: TaskContinuationEventRecord | null,
  capabilityScoped = false,
  continuationHint: TaskContinuationStatusHint = { code: null, message: null, nextStep: null },
) {
  return {
    task: {
      task_id: task.task_id,
      output_url: `/api/tasks/${capabilityScoped ? 'mcp/' : ''}${encodeURIComponent(task.task_id)}/output`,
      session_id: task.session_id,
      run_id: task.run_id,
      title: task.title,
      auto_notify: task.auto_notify,
      notification_cancelled_at: task.notification_cancelled_at,
      notification_cancelled_reason: task.notification_cancelled_reason,
      status: task.status,
      exit_code: task.exit_code,
      result_summary: task.result_summary,
      last_error: task.last_error,
      created_at: task.created_at,
      updated_at: task.updated_at,
    },
    continuationEvent: continuationEvent ? {
      status: continuationEvent.status,
      attempts: continuationEvent.attempts,
      last_error: continuationEvent.last_error,
      created_at: continuationEvent.created_at,
      updated_at: continuationEvent.updated_at,
    } : null,
    continuationHint: {
      code: continuationHint.code,
      message: continuationHint.message,
      next_step: continuationHint.nextStep,
    },
  };
}

function buildTaskStatusResponse(
  task: AsyncTaskRecord,
  continuationEvent: TaskContinuationEventRecord | null,
  capabilityScoped = false,
) {
  const session = sessionsDb.getSessionById(task.session_id);
  const targetMatches = Boolean(session
    && session.provider === 'codex'
    && session.provider_session_id === task.provider_thread_id
    && session.project_path
    && task.session_project_path
    && path.resolve(session.project_path) === path.resolve(task.session_project_path));
  const hint = getTaskContinuationStatusHint({
    task,
    event: continuationEvent,
    enabled: areTaskContinuationsEnabled(),
    archived: Boolean(session?.isArchived),
    targetMatches,
    conversationBusy: chatRunRegistry.isProcessing(task.session_id),
    backgroundWork: providerRuntimeService.hasBackgroundWork(task.session_id),
    pendingApproval: providerRuntimeService.getPendingApprovalsForSession(task.session_id).length > 0,
  });
  return toPublicTaskStatus(task, continuationEvent, capabilityScoped, hint);
}

export const taskContinuationsRouter = express.Router();

taskContinuationsRouter.get(
  '/config/continuations',
  authenticateToken,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ enabled: areTaskContinuationsEnabled() }));
  }),
);

taskContinuationsRouter.put(
  '/config/continuations',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean') {
      throw new AppError('enabled must be a boolean.', {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }
    setTaskContinuationsEnabled(body.enabled);
    res.json(createApiSuccessResponse({ enabled: areTaskContinuationsEnabled() }));
  }),
);

taskContinuationsRouter.post(
  '/mcp/register',
  asyncHandler(async (req: Request, res: Response) => {
    const { context, token } = readTaskRunCapability(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = readString(body.title, 'title');
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    const command = body.command;
    if (title.length > 200 || !requestId || requestId.length > 256
      || !Array.isArray(command) || command.length < 1 || command.length > 129
      || command.some((argument) => typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0'))
      || typeof command[0] !== 'string' || !command[0].trim()
      || (body.autoNotify !== undefined && typeof body.autoNotify !== 'boolean')) {
      throw new AppError('Task registration request is invalid.', {
        code: 'INVALID_TASK_REGISTRATION',
        statusCode: 400,
      });
    }
    const result = await registerAndStartTaskFromRun({
      context,
      capabilityToken: token,
      requestId,
      title,
      command: command as string[],
      autoNotify: body.autoNotify === true,
    });
    res.status(result.duplicate ? 200 : 202).json(createApiSuccessResponse(result));
  }),
);

taskContinuationsRouter.get(
  '/mcp/:id/output',
  asyncHandler(async (req: Request, res: Response) => {
    const context = readTaskRunContext(req);
    const output = await readTaskOutputForScope(readParamId(req.params.id), {
      userId: context.userId,
      sessionId: context.sessionId,
    });
    res.json(createApiSuccessResponse({ output }));
  }),
);

/**
 * Registers an asynchronous local task.
 */
taskContinuationsRouter.post(
  '/register',
  authenticateToken,
  asyncHandler(async (_req: Request, _res: Response) => {
    throw new AppError('Task registration requires a trusted Codex run capability.', {
      code: 'TASK_REGISTRATION_UNSUPPORTED',
      statusCode: 410,
    });
  }),
);

function readParamId(param: string | string[] | undefined): string {
  if (Array.isArray(param)) {
    return param[0] ?? '';
  }
  return typeof param === 'string' ? param : '';
}

/**
 * Reads a task for the active run's user and chat. A later run in the same chat
 * may manage an earlier task; the current run id is not an ownership boundary.
 */
taskContinuationsRouter.get(
  '/mcp/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const context = readTaskRunContext(req);
    const result = await handleGetTaskStatus(readParamId(req.params.id), {
      userId: context.userId,
      sessionId: context.sessionId,
    });
    res.json(createApiSuccessResponse(buildTaskStatusResponse(result.task, result.continuationEvent, true)));
  }),
);

taskContinuationsRouter.post(
  '/mcp/:id/cancel-notification',
  asyncHandler(async (req: Request, res: Response) => {
    const context = readTaskRunContext(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;
    const success = await handleCancelTaskNotification(readParamId(req.params.id), {
      userId: context.userId,
      sessionId: context.sessionId,
    }, reason);
    res.json(createApiSuccessResponse({ success }));
  }),
);

/**
 * Receives the final result and status from the local task runner.
 */
taskContinuationsRouter.post(
  '/:id/finish',
  asyncHandler(async (req: Request, res: Response) => {
    const taskId = readParamId(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskToken = readString(body.taskToken, 'taskToken');
    const status = readString(body.status, 'status');
    const resultDigest = readString(body.resultDigest, 'resultDigest');

    const result = await handleTaskFinishRequest({
      taskId,
      taskToken,
      status,
      exitCode: body.exitCode,
      resultDigest,
      resultPath: typeof body.resultPath === 'string' ? body.resultPath : null,
      resultSummary: body.resultSummary,
      resultJson: body.resultJson,
    });

    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * Queries the current status and delivery status of a task.
 */
taskContinuationsRouter.get(
  '/:id',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const taskId = readParamId(req.params.id);
    const result = await handleGetTaskStatus(taskId, { userId: readUserId(req) });
    res.json(createApiSuccessResponse(buildTaskStatusResponse(result.task, result.continuationEvent)));
  }),
);

taskContinuationsRouter.get(
  '/:id/output',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const output = await readTaskOutputForScope(readParamId(req.params.id), { userId: readUserId(req) });
    res.json(createApiSuccessResponse({ output }));
  }),
);

/**
 * Cancels a pending notification for a task.
 */
taskContinuationsRouter.post(
  '/:id/cancel-notification',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const taskId = readParamId(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const success = await handleCancelTaskNotification(taskId, { userId: readUserId(req) }, reason);
    res.json(createApiSuccessResponse({ success }));
  }),
);

/** Requires an explicit owner confirmation because history may not prove whether delivery happened. */
taskContinuationsRouter.post(
  '/:id/retry-notification',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.confirmMayDuplicate !== true) {
      throw new AppError('Explicit duplicate-risk confirmation is required.', {
        code: 'TASK_DUPLICATE_RISK_CONFIRMATION_REQUIRED', statusCode: 400,
      });
    }
    const reason = readString(body.reason, 'reason');
    if (reason.length > 500) {
      throw new AppError('reason must be 500 characters or fewer.', {
        code: 'INVALID_MANUAL_RETRY_REASON', statusCode: 400,
      });
    }
    const requeued = await handleManualRetryTaskNotification(readParamId(req.params.id), {
      userId: readUserId(req),
    }, reason);
    if (!requeued) {
      throw new AppError('The notification is no longer available for manual retry.', {
        code: 'TASK_NOTIFICATION_NOT_REVIEWABLE', statusCode: 409,
      });
    }
    res.json(createApiSuccessResponse({
      requeued: true,
      warning: 'The prior attempt may already have run. Review the task output before acting on a duplicate report.',
    }));
  }),
);

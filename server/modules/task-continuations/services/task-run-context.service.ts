import crypto from 'node:crypto';
import path from 'node:path';

import { hashToken } from '@/modules/task-continuations/services/task-token.service.js';
import type { TaskRunCapabilityContext } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const TASK_RUN_CAPABILITY_TTL_MS = 30 * 60 * 1000;
const MAX_ACTIVE_TASK_RUN_CAPABILITIES = 256;

type ActiveTaskRunCapability = {
  context: TaskRunCapabilityContext;
  expiresAt: number;
};

const activeCapabilities = new Map<string, ActiveTaskRunCapability>();

function assertValidContext(context: TaskRunCapabilityContext): void {
  if (!Number.isSafeInteger(context.userId) || context.userId <= 0
    || !context.sessionId.trim() || !context.runId.trim()
    || (context.providerThreadId !== null && !context.providerThreadId.trim())
    || !path.isAbsolute(context.sessionProjectPath)
    || !path.isAbsolute(context.cwd)
    || !['workspaceWrite', 'dangerFullAccess'].includes(context.sandboxPolicy.type)
    || typeof context.sandboxPolicy.networkAccess !== 'boolean'
    || !['never', 'on-request'].includes(context.approvalPolicy)) {
    throw new AppError('Task run context is invalid.', { code: 'INVALID_TASK_RUN_CONTEXT', statusCode: 400 });
  }
}

function pruneExpiredCapabilities(now = Date.now()): void {
  for (const [hash, capability] of activeCapabilities) {
    if (capability.expiresAt <= now) {
      activeCapabilities.delete(hash);
    }
  }
}

/**
 * Creates a short-lived opaque capability for one trusted Codex run.
 * The raw token is returned once for the app-server's isolated MCP environment;
 * only its SHA-256 digest is retained in the host process.
 */
export function createTaskRunCapability(context: TaskRunCapabilityContext): {
  token: string;
  expiresAt: number;
} {
  assertValidContext(context);
  pruneExpiredCapabilities();
  if (activeCapabilities.size >= MAX_ACTIVE_TASK_RUN_CAPABILITIES) {
    throw new AppError('Too many active task run capabilities.', {
      code: 'TASK_RUN_CAPABILITY_CAPACITY',
      statusCode: 503,
    });
  }

  const token = `trc_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = Date.now() + TASK_RUN_CAPABILITY_TTL_MS;
  const trustedContext = Object.freeze({
    ...context,
    sandboxPolicy: Object.freeze({ ...context.sandboxPolicy }),
  });
  activeCapabilities.set(hashToken(token), { context: trustedContext, expiresAt });
  return { token, expiresAt };
}

/** Resolves an active capability without disclosing a token or context on failure. */
export function resolveTaskRunCapability(token: string): TaskRunCapabilityContext | null {
  if (!token) {
    return null;
  }
  pruneExpiredCapabilities();
  const entry = activeCapabilities.get(hashToken(token));
  return entry ? { ...entry.context, sandboxPolicy: { ...entry.context.sandboxPolicy } } : null;
}

/** Binds the native thread announced by app-server to the active trusted run capability. */
export function setTaskRunProviderThreadId(token: string, providerThreadId: string): boolean {
  if (!providerThreadId.trim()) return false;
  pruneExpiredCapabilities();
  const entry = activeCapabilities.get(hashToken(token));
  if (!entry) return false;
  entry.context = Object.freeze({ ...entry.context, providerThreadId });
  return true;
}

/** Revokes registration authority when the originating chat run settles. */
export function revokeTaskRunCapability(token: string): boolean {
  if (!token) {
    return false;
  }
  return activeCapabilities.delete(hashToken(token));
}

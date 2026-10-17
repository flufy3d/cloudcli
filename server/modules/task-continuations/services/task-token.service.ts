import crypto from 'node:crypto';

import { sha256Hex } from '@/shared/utils.js';

/**
 * Calculates SHA-256 hash of a token for persistent storage and secure comparison.
 *
 * Consumed by task registration, callback verification, and route handlers.
 */
export function hashToken(token: string): string {
  return sha256Hex(token);
}

/**
 * Generates an opaque high-entropy callback token for a specific task.
 *
 * Consumed by task registration and local task runner setup.
 */
export function generateTaskCallbackToken(taskId: string): string {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `tcb_${taskId}_${randomBytes}`;
}

/**
 * Constant-time verification of a task callback token against its stored hash.
 *
 * Consumed by finish callback route and task query handlers.
 */
export function verifyTaskCallbackToken(token: string, expectedHash: string): boolean {
  if (!token || !expectedHash) {
    return false;
  }
  const tokenHash = hashToken(token);
  if (tokenHash.length !== expectedHash.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(expectedHash));
  } catch {
    return false;
  }
}

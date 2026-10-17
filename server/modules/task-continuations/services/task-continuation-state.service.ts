import type { TaskContinuationEventStatus } from '@/shared/types.js';
import { sha256Hex } from '@/shared/utils.js';

/**
 * Calculates a SHA-256 digest string for arbitrary string or buffer content.
 *
 * Consumed by task registration, finish callbacks, and state validation.
 */
export function calculateResultDigest(content: string | Buffer): string {
  return sha256Hex(content);
}

/**
 * Checks whether a given task continuation event status is in an unalterable terminal state.
 *
 * Consumed by task-continuation dispatcher, recovery routines, and state transitions.
 */
export function isTerminalStatus(status: TaskContinuationEventStatus): boolean {
  return (
    status === 'delivered' ||
    status === 'reply_failed' ||
    status === 'cancelled' ||
    status === 'needs_review'
  );
}

/**
 * Checks whether an ISO expiration timestamp represents an active lease.
 *
 * Consumed by lease reclamation and dispatchers.
 */
export function isLeaseActive(expiresAt: string | null): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiryTime = new Date(expiresAt).getTime();
  return !Number.isNaN(expiryTime) && expiryTime > Date.now();
}

const ALLOWED_TRANSITIONS: Record<TaskContinuationEventStatus, ReadonlySet<TaskContinuationEventStatus>> = {
  pending: new Set(['claimed', 'cancelled']),
  claimed: new Set(['pending', 'sending', 'cancelled']),
  sending: new Set(['accepted', 'pending', 'uncertain']),
  accepted: new Set(['delivered', 'reply_failed']),
  uncertain: new Set(['accepted', 'pending', 'needs_review']),
  delivered: new Set(),
  reply_failed: new Set(),
  cancelled: new Set(),
  needs_review: new Set(),
};

/**
 * Validates if transitioning from `current` to `next` event status conforms to the state machine.
 *
 * Consumed by task continuation services, recovery verification, and event processors.
 */
export function validateStateTransition(
  current: TaskContinuationEventStatus,
  next: TaskContinuationEventStatus,
): boolean {
  const allowed = ALLOWED_TRANSITIONS[current];
  return Boolean(allowed && allowed.has(next));
}

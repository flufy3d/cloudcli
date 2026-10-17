import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateResultDigest,
  isLeaseActive,
  isTerminalStatus,
  validateStateTransition,
} from '@/modules/task-continuations/services/task-continuation-state.service.js';

test('calculateResultDigest returns deterministic sha256 hash', () => {
  const digest1 = calculateResultDigest('hello world');
  const digest2 = calculateResultDigest('hello world');
  const digest3 = calculateResultDigest('hello world 2');

  assert.equal(digest1, digest2);
  assert.notEqual(digest1, digest3);
  assert.equal(digest1.length, 64);
});

test('isTerminalStatus accurately identifies terminal delivery states', () => {
  assert.equal(isTerminalStatus('delivered'), true);
  assert.equal(isTerminalStatus('reply_failed'), true);
  assert.equal(isTerminalStatus('cancelled'), true);
  assert.equal(isTerminalStatus('needs_review'), true);

  assert.equal(isTerminalStatus('pending'), false);
  assert.equal(isTerminalStatus('claimed'), false);
  assert.equal(isTerminalStatus('sending'), false);
  assert.equal(isTerminalStatus('accepted'), false);
  assert.equal(isTerminalStatus('uncertain'), false);
});

test('isLeaseActive checks expiration properly', () => {
  assert.equal(isLeaseActive(null), false);

  const future = new Date(Date.now() + 10_000).toISOString();
  assert.equal(isLeaseActive(future), true);

  const past = new Date(Date.now() - 10_000).toISOString();
  assert.equal(isLeaseActive(past), false);
});

test('validateStateTransition validates allowed and forbidden transitions', () => {
  // pending -> claimed or cancelled
  assert.equal(validateStateTransition('pending', 'claimed'), true);
  assert.equal(validateStateTransition('pending', 'cancelled'), true);
  assert.equal(validateStateTransition('pending', 'delivered'), false);

  // claimed -> pending, sending, cancelled
  assert.equal(validateStateTransition('claimed', 'pending'), true);
  assert.equal(validateStateTransition('claimed', 'sending'), true);
  assert.equal(validateStateTransition('claimed', 'cancelled'), true);
  assert.equal(validateStateTransition('claimed', 'delivered'), false);

  // sending -> accepted, pending (known busy/not sent), uncertain
  assert.equal(validateStateTransition('sending', 'accepted'), true);
  assert.equal(validateStateTransition('sending', 'pending'), true);
  assert.equal(validateStateTransition('sending', 'uncertain'), true);

  // accepted -> delivered, reply_failed
  assert.equal(validateStateTransition('accepted', 'delivered'), true);
  assert.equal(validateStateTransition('accepted', 'reply_failed'), true);
  assert.equal(validateStateTransition('accepted', 'pending'), false);

  // uncertain -> accepted, pending, needs_review
  assert.equal(validateStateTransition('uncertain', 'accepted'), true);
  assert.equal(validateStateTransition('uncertain', 'pending'), true);
  assert.equal(validateStateTransition('uncertain', 'needs_review'), true);
  assert.equal(validateStateTransition('uncertain', 'delivered'), false);

  // terminal states cannot transition to anything
  assert.equal(validateStateTransition('delivered', 'pending'), false);
  assert.equal(validateStateTransition('reply_failed', 'pending'), false);
  assert.equal(validateStateTransition('cancelled', 'pending'), false);
  assert.equal(validateStateTransition('needs_review', 'pending'), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { getTaskContinuationStatusHint } from '@/modules/task-continuations/services/task-continuation-status.service.js';
import type { AsyncTaskRecord, TaskContinuationEventRecord } from '@/shared/types.js';

const task: AsyncTaskRecord = {
  task_id: 'task_status_hint', user_id: 1, session_id: 'session_status_hint', run_id: 'run_status_hint',
  provider_thread_id: 'native_status_hint', session_project_path: '/workspace', working_directory: '/workspace',
  sandbox_policy_type: 'workspaceWrite', network_access: 0, approval_policy: 'on-request', title: 'hint', command: null,
  registration_key: null, auto_notify: 1, notification_cancelled_at: null, notification_cancelled_reason: null,
  status: 'completed', exit_code: 0, result_digest: 'digest', result_path: null, result_summary: 'done',
  result_json: null, last_error: null, token_hash: 'hash', token_expires_at: null,
  created_at: '2026-10-17T00:00:00.000Z', updated_at: '2026-10-17T00:00:00.000Z',
};

const event: TaskContinuationEventRecord = {
  event_id: 'evt_status_hint', task_id: task.task_id, session_id: task.session_id, status: 'pending',
  attempts: 0, lease_owner: null, lease_expires_at: null, lease_expires_at_ms: null, last_attempt_at: null,
  engine_turn_id: null, host_run_id: null, last_error: null,
  created_at: '2026-10-17T00:00:00.000Z', updated_at: '2026-10-17T00:00:00.000Z',
};

const base = {
  task, event, enabled: true, archived: false, targetMatches: true,
  conversationBusy: false, backgroundWork: false, pendingApproval: false,
};

test('status hints give a next step when automatic dispatch is disabled', () => {
  const hint = getTaskContinuationStatusHint({ ...base, enabled: false });
  assert.equal(hint.code, 'continuations_disabled');
  assert.match(hint.message ?? '', /new reports are not sent/i);
  assert.match(hint.nextStep ?? '', /continuation-config.*--enabled true/);
});

test('status hints explain transient busy and archived target pauses', () => {
  const busy = getTaskContinuationStatusHint({ ...base, conversationBusy: true });
  assert.equal(busy.code, 'conversation_busy');
  assert.match(busy.nextStep ?? '', /No action.*retry/i);

  const archived = getTaskContinuationStatusHint({ ...base, archived: true });
  assert.equal(archived.code, 'conversation_archived');
  assert.match(archived.nextStep ?? '', /restore|unarchive/i);
});

test('status hints distinguish engine background work and pending approval', () => {
  assert.equal(getTaskContinuationStatusHint({ ...base, backgroundWork: true }).code, 'engine_background_work');
  assert.equal(getTaskContinuationStatusHint({ ...base, pendingApproval: true }).code, 'approval_pending');
});

test('needs_review tells the owner that no automatic retry occurs and names the duplicate-risk action', () => {
  const hint = getTaskContinuationStatusHint({ ...base, event: { ...event, status: 'needs_review' } });
  assert.equal(hint.code, 'manual_review_required');
  assert.match(hint.message ?? '', /will not retry it automatically/i);
  assert.match(hint.nextStep ?? '', /confirm-may-duplicate/);
});

test('accepted reports explain pending approval even while the global switch is off', () => {
  const acceptedEvent = { ...event, status: 'accepted' as const };
  const approval = getTaskContinuationStatusHint({ ...base, event: acceptedEvent, pendingApproval: true });
  assert.equal(approval.code, 'approval_pending');
  assert.match(approval.nextStep ?? '', /resolve the approval/i);

  const acceptedWhileDisabled = getTaskContinuationStatusHint({ ...base, event: acceptedEvent, enabled: false });
  assert.equal(acceptedWhileDisabled.code, 'notification_in_progress');
  assert.match(acceptedWhileDisabled.message ?? '', /handling this task report/i);
});

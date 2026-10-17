import type { AsyncTaskRecord, TaskContinuationEventRecord } from '@/shared/types.js';

export type TaskContinuationStatusHint = {
  code: string | null;
  message: string | null;
  nextStep: string | null;
};

export function getTaskContinuationStatusHint(input: {
  task: AsyncTaskRecord;
  event: TaskContinuationEventRecord | null;
  enabled: boolean;
  archived: boolean;
  targetMatches: boolean;
  conversationBusy: boolean;
  backgroundWork: boolean;
  pendingApproval: boolean;
}): TaskContinuationStatusHint {
  const hint = (code: string, message: string, nextStep: string): TaskContinuationStatusHint => ({ code, message, nextStep });
  const event = input.event;

  if (event?.status === 'needs_review') {
    return hint(
      'manual_review_required',
      'CloudCLI cannot confirm whether the earlier notification was delivered and will not retry it automatically.',
      'Check the task output and original chat history. If a duplicate report is acceptable, use retry-notification with --confirm-may-duplicate and a reason; otherwise leave it for review.',
    );
  }
  if (event?.status === 'delivered' || event?.status === 'reply_failed' || event?.status === 'cancelled') {
    return { code: null, message: null, nextStep: null };
  }
  if (input.task.notification_cancelled_at) {
    return hint('notification_cancelled', 'Automatic notification was cancelled; the task result remains saved.', 'No action is needed unless you want a separate report.');
  }
  if (input.task.auto_notify !== 1) {
    return hint('notification_not_requested', 'This task was not registered for automatic reporting.', 'Use the saved task output if you need the result.');
  }
  if (input.pendingApproval) {
    return hint('approval_pending', 'The original chat has a tool approval waiting for a decision.', 'Resolve the approval in the original chat; CloudCLI will not approve it automatically.');
  }
  if (event?.status === 'sending' || event?.status === 'accepted') {
    return hint('notification_in_progress', 'The original chat is handling this task report.', 'Wait for the chat turn to finish.');
  }
  if (!input.enabled) {
    return hint(
      'continuations_disabled',
      'Automatic task reports are paused. Task results continue to be saved, but new reports are not sent.',
      'An authenticated owner can run continuation-config --enabled true when automatic reports should resume.',
    );
  }
  if (input.archived) {
    return hint('conversation_archived', 'The original chat is archived, so task reporting is paused.', 'Restore the original chat before reporting can resume.');
  }
  if (!input.targetMatches) {
    return hint('original_target_changed', 'The original chat or its execution target changed; this task will not be sent to a different target.', 'Review the task and original chat before taking another action.');
  }
  if (input.conversationBusy) {
    return hint('conversation_busy', 'The original chat is handling another request.', 'No action is needed; CloudCLI will retry the report after the chat becomes idle.');
  }
  if (input.backgroundWork) {
    return hint('engine_background_work', 'The original chat still has engine background work.', 'No action is needed; CloudCLI will wait until the engine is idle.');
  }
  if (input.task.status === 'registered' || input.task.status === 'running') {
    return hint('task_running', 'The background task has not saved a final result yet.', 'Wait for the task to finish; CloudCLI will save its result before reporting.');
  }
  if (event?.status === 'claimed') {
    return hint('notification_claimed', 'The report is queued for the original chat.', 'No action is needed; CloudCLI will continue dispatching it.');
  }
  return event?.status === 'pending'
    ? hint('notification_pending', 'The report is waiting to be sent to the original chat.', 'No action is needed; CloudCLI will send it when dispatch is available.')
    : { code: null, message: null, nextStep: null };
}

import type { SubagentActivity } from '@/shared/types';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';

const MAX_STEP_LENGTH = 80;

/** Input fields that say most about what a tool call is doing, most telling first. */
const INPUT_HINT_FIELDS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt'] as const;

const clip = (text: string): string => {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  return line.length > MAX_STEP_LENGTH ? `${line.slice(0, MAX_STEP_LENGTH - 1)}…` : line;
};

/**
 * One line on what a subagent did last, for the card header while it runs:
 * "Bash: npm test" for a tool call, the first line for a prose step. Undefined
 * before the agent has done anything.
 *
 * Used by the subagent panel.
 */
export function describeLatestStep(activity: SubagentActivity[]): string | undefined {
  const last = activity[activity.length - 1];
  if (!last) {
    return undefined;
  }
  if (last.kind !== 'tool') {
    return clip(last.content ?? '') || undefined;
  }
  const name = last.toolName || 'tool';
  const input = parseToolPayload(last.toolInput);
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : null;
  const hint = record
    ? INPUT_HINT_FIELDS.map((field) => record[field]).find((value) => typeof value === 'string' && value.trim())
    : typeof input === 'string' ? input : undefined;
  const detail = typeof hint === 'string' ? clip(hint) : '';
  const full = detail ? `${name}: ${detail}` : name;
  return full.length > MAX_STEP_LENGTH ? `${full.slice(0, MAX_STEP_LENGTH - 1)}…` : full;
}

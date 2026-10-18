import { describe, expect, it } from 'vitest';

import { describeLatestStep } from '@/modules/chat/utils/subagentSteps';
import type { SubagentActivity } from '@/shared/types';

const tool = (toolName: string, toolInput: unknown): SubagentActivity => ({ kind: 'tool', toolName, toolInput });

describe('describeLatestStep', () => {
  it('names the newest tool call with its command', () => {
    expect(describeLatestStep([tool('Read', { file_path: '/a.ts' }), tool('Bash', { command: 'npm test' })])).toBe('Bash: npm test');
  });

  it('reads a JSON-string input and other common fields', () => {
    expect(describeLatestStep([tool('Read', JSON.stringify({ file_path: '/src/a.ts' }))])).toBe('Read: /src/a.ts');
    expect(describeLatestStep([tool('Grep', { pattern: 'TODO' })])).toBe('Grep: TODO');
  });

  it('keeps long input short and on one line', () => {
    const text = describeLatestStep([tool('Bash', { command: `echo ${'x'.repeat(200)}\nsecond line` })]);
    expect(text?.length).toBeLessThanOrEqual(80);
    expect(text).not.toContain('\n');
  });

  it('falls back to the bare name when the input has nothing to show', () => {
    expect(describeLatestStep([tool('Glob', {})])).toBe('Glob');
  });

  it('describes a prose step by its first line', () => {
    expect(describeLatestStep([{ kind: 'text', content: 'Reading the diff.\nMore.' }])).toBe('Reading the diff.');
  });

  it('is undefined when there are no steps', () => {
    expect(describeLatestStep([])).toBeUndefined();
  });
});

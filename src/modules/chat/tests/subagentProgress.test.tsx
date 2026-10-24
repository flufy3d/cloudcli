import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '@/modules/i18n';

import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { SubagentActivity, SubagentInfo } from '@/shared/types';

const steps = (count: number): SubagentActivity[] => Array.from({ length: count }, (_, index) => (
  index === count - 1
    ? { kind: 'tool', toolId: `t${index}`, toolName: 'Bash', toolInput: { command: 'npm test' } }
    : { kind: 'text', content: `step number ${index + 1}` }
));

const mount = (activity: SubagentActivity[], subagent?: SubagentInfo) => render(React.createElement(SubagentPanel, {
  toolInput: JSON.stringify({ subagent_type: 'Explore', description: 'Survey' }),
  toolResult: null,
  subagent,
  activity,
  createDiff: createCachedDiffCalculator(),
}));

describe('a running subagent card', () => {
  it('shows its step count and latest step without being opened', () => {
    mount(steps(3));
    expect(screen.getByText(/3 steps/)).toBeTruthy();
    expect(screen.getByText(/Bash: npm test/)).toBeTruthy();
  });

  it('opens on the newest steps, not the first ones', () => {
    mount(steps(40));
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByText('step number 39')).toBeTruthy();
    expect(screen.queryByText('step number 1')).toBeNull();
    expect(screen.getByText(/earlier/)).toBeTruthy();
  });

  it('keeps showing the first steps once the agent is done', () => {
    mount(steps(40), { id: 'a', status: 'completed' });
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByText('step number 1')).toBeTruthy();
    expect(screen.queryByText('step number 39')).toBeNull();
  });

  it('does not summarize progress for a finished card', () => {
    mount(steps(3), { id: 'a', status: 'completed' });
    expect(screen.queryByText(/Bash: npm test/)).toBeNull();
  });
});

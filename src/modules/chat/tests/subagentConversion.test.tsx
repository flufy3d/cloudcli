import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { NormalizedMessage } from '@/shared/types';

const base = { sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z', provider: 'claude' as const };
let counter = 0;
const row = (fields: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): NormalizedMessage => {
  counter += 1;
  return { id: `r${counter}`, ...base, ...fields } as NormalizedMessage;
};

const agentCall = (extra: Partial<NormalizedMessage> = {}) => row({
  kind: 'tool_use', toolName: 'Agent', toolId: 'call_agent', toolInput: { subagent_type: 'Explore', description: 'Survey' }, ...extra,
});
const childTool = () => row({
  kind: 'tool_use', toolName: 'Read', toolId: 'call_child', toolInput: { file_path: '/tmp/a.ts' }, parentToolUseId: 'call_agent',
});
const childResult = () => row({ kind: 'tool_result', toolId: 'call_child', content: 'file body', parentToolUseId: 'call_agent' });
const childText = () => row({ kind: 'text', role: 'assistant', content: 'Reading the file.', parentToolUseId: 'call_agent' });

describe('the subagent card in the converted transcript', () => {
  it('carries the backend status and timeline from a history row', () => {
    const [card] = normalizedToChatMessages([agentCall({
      subagent: { id: 'a1', status: 'completed', type: 'Explore' },
      subagentTools: [{ kind: 'tool', toolId: 't1', toolName: 'Read', toolInput: {}, toolResult: { content: 'x' } }],
    })]);
    expect(card.subagent).toEqual({ id: 'a1', status: 'completed', type: 'Explore' });
    expect(card.subagentActivity?.map((entry) => entry.toolName)).toEqual(['Read']);
  });

  it('folds live child rows into the card instead of the main thread', () => {
    const converted = normalizedToChatMessages([agentCall(), childText(), childTool(), childResult()]);
    expect(converted).toHaveLength(1);
    expect(converted[0].subagentActivity?.map((entry) => [entry.kind, entry.toolName ?? entry.content])).toEqual([
      ['text', 'Reading the file.'],
      ['tool', 'Read'],
    ]);
    expect(converted[0].subagentActivity?.[1].toolResult).toEqual({ content: 'file body', isError: false });
  });

  it('prefers the history timeline when the row carries one', () => {
    const [card] = normalizedToChatMessages([
      agentCall({ subagentTools: [{ kind: 'text', content: 'from history' }] }),
      childText(),
    ]);
    expect(card.subagentActivity?.map((entry) => entry.content)).toEqual(['from history']);
  });

  it('leaves rows alone when their parent call is not an Agent card', () => {
    const converted = normalizedToChatMessages([
      row({ kind: 'tool_use', toolName: 'Bash', toolId: 'call_agent', toolInput: {} }),
      childText(),
    ]);
    expect(converted.filter((message) => message.content === 'Reading the file.')).toHaveLength(1);
  });

  it('refreshes the card when a child row arrives after the first conversion', () => {
    const call = agentCall();
    const first = normalizedToChatMessages([call, childText()]);
    expect(first[0].subagentActivity).toHaveLength(1);

    const tool = childTool();
    const second = normalizedToChatMessages([call, childText(), tool]);
    expect(second[0].subagentActivity).toHaveLength(2);
    expect(second[0]).not.toBe(first[0]);
  });
});

it('refreshes the card when a folded child call\'s result arrives later', () => {
  const call = agentCall();
  const tool = childTool();
  const first = normalizedToChatMessages([call, tool]);
  expect(first[0].subagentActivity?.[0].toolResult).toBeNull();

  const second = normalizedToChatMessages([call, tool, childResult()]);
  expect(second[0].subagentActivity?.[0].toolResult).toEqual({ content: 'file body', isError: false });
});

describe('the subagent panel with a timeline', () => {
  it('shows the agent\'s steps once opened', () => {
    const [card] = normalizedToChatMessages([agentCall(), childText(), childTool(), childResult()]);
    render(React.createElement(SubagentPanel, {
      toolInput: card.toolInput,
      toolResult: card.toolResult,
      subagent: card.subagent,
      taskStatus: card.taskStatus,
      activity: card.subagentActivity,
      createDiff: createCachedDiffCalculator(),
    }));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Reading the file.')).toBeTruthy();
    expect(document.body.textContent).toContain('Read');
  });
});

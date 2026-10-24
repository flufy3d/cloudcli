import { describe, expect, it } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { getToolDisplayCategory } from '@/modules/chat/tools/toolTaxonomy';
import type { NormalizedMessage } from '@/shared/types';
import { SUBAGENT_TOOL_NAME } from '@shared/protocol/subagent';

const toolUse = (toolName: string, id = 't1'): NormalizedMessage => ({
  id,
  sessionId: 's1',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  kind: 'tool_use',
  toolName,
  toolInput: {},
  toolId: id,
});

/**
 * The client draws the subagent card for exactly one tool name. `Task` is the
 * task-list family (`TaskCreate`, `manage_task`), so matching it as a subagent
 * would paint a to-do item as an agent.
 */
describe('subagent card recognition', () => {
  it('names the subagent tool Agent', () => {
    expect(SUBAGENT_TOOL_NAME).toBe('Agent');
  });

  it('routes an Agent call to the subagent panel', () => {
    const [row] = normalizedToChatMessages([toolUse('Agent')]);
    expect(row.isSubagentContainer).toBe(true);
  });

  it.each(['Task', 'TaskCreate', 'TaskUpdate', 'manage_task', 'Bash'])('does not route %s to the subagent panel', (name) => {
    const [row] = normalizedToChatMessages([toolUse(name)]);
    expect(row.isSubagentContainer).toBe(false);
  });

  it('files Agent under the agent display category and Task under none', () => {
    expect(getToolDisplayCategory('Agent')).toBe('agent');
    expect(getToolDisplayCategory('Task')).toBe('default');
  });
});

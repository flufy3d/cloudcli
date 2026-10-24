import { SUBAGENT_TOOL_NAME, canonicalClaudeSubagentToolName } from '@/shared/utils.js';

type AgentCall = { description?: string };

/** The `Agent` card a tool call was made under. */
export type SubagentOrigin = { toolUseId: string; description?: string };

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The agent's task line: its description, else the first line of its prompt. */
function describeAgentCall(input: Record<string, unknown> | undefined): string | undefined {
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  if (description) {
    return description;
  }
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  return prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

/**
 * Remembers which `Agent` card each tool call of a Claude run was made under.
 *
 * The SDK's `canUseTool` callback is shared by the main thread and every
 * subagent; it names the call (`toolUseID`) but not the card. The stream does:
 * each subagent message carries `parent_tool_use_id`, so the tracker records
 * the parent of every tool call it sees, and an approval request looks its call
 * up here. A call inside a nested agent resolves to the outermost card, the
 * only one the user sees.
 *
 * Consumer: the Claude runtime, one tracker per run.
 */
export function createSubagentOriginTracker() {
  const parentOfCall = new Map<string, string>();
  const agentCalls = new Map<string, AgentCall>();
  const seenCalls = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();

  return {
    /** Feeds one SDK stream message. */
    observe(sdkMessage: unknown): void {
      const message = readObject(sdkMessage);
      if (message?.type !== 'assistant') {
        return;
      }
      const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : undefined;
      const content = readObject(message.message)?.content;
      if (!Array.isArray(content)) {
        return;
      }
      for (const block of content) {
        const call = readObject(block);
        if (call?.type !== 'tool_use' || typeof call.id !== 'string') {
          continue;
        }
        if (parent) {
          parentOfCall.set(call.id, parent);
        }
        seenCalls.add(call.id);
        for (const wake of waiters.get(call.id) ?? []) {
          wake();
        }
        waiters.delete(call.id);
        if (typeof call.name === 'string' && canonicalClaudeSubagentToolName(call.name) === SUBAGENT_TOOL_NAME) {
          agentCalls.set(call.id, { description: describeAgentCall(readObject(call.input)) });
        }
      }
    },

    /**
     * Resolves once the stream has shown the call, or after `timeoutMs`. The
     * approval request and the stream travel separately, so a request can
     * arrive first; asking here before `originOf` keeps its card from losing
     * the origin.
     */
    whenObserved(toolUseId: string | undefined, timeoutMs: number): Promise<void> {
      if (!toolUseId || seenCalls.has(toolUseId)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
        const list = waiters.get(toolUseId) ?? [];
        list.push(done);
        waiters.set(toolUseId, list);
      });
    },

    /** The card a tool call belongs to, or undefined for a main-thread call. */
    originOf(toolUseId: string | undefined): SubagentOrigin | undefined {
      let current = toolUseId ? parentOfCall.get(toolUseId) : undefined;
      for (let depth = 0; current && depth < 16; depth += 1) {
        const next = parentOfCall.get(current);
        if (!next) {
          break;
        }
        current = next;
      }
      if (!current) {
        return undefined;
      }
      const description = agentCalls.get(current)?.description;
      return { toolUseId: current, ...(description ? { description } : {}) };
    },
  };
}

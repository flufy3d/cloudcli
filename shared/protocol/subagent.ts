/**
 * The one tool name that marks a `tool_use` row as a spawned subagent.
 *
 * Every engine adapter translates its native spawn (Claude's `Agent`/`Task`,
 * Codex's `SubAgentActivity`, OpenCode's `subagent`, Antigravity's
 * `invoke_subagent`, ZCode's `Agent`) into a row with this name, and the client
 * renders the subagent card for this name only. `Task` is not a subagent name:
 * it belongs to the task-list tools (`TaskCreate`, `TaskUpdate`, `manage_task`).
 *
 * Consumers: the provider adapters (server) and the chat timeline (client),
 * which import this same constant so the two sides cannot drift.
 */
export const SUBAGENT_TOOL_NAME = 'Agent';

/** Whether a tool name is the subagent card's name. */
export function isSubagentToolName(toolName: unknown): boolean {
  return toolName === SUBAGENT_TOOL_NAME;
}

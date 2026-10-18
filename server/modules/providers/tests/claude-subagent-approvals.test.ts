import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { claudeRuntime, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

const NATIVE_ID = 'native-approvals';
const SESSION_ID = 'app-approvals';

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: parent,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

type Ask = (toolName: string, input: unknown, toolUseID: string) => Promise<unknown>;

/**
 * Runs the real runtime over a scripted SDK stream. `script` receives `ask`,
 * the SDK's `canUseTool` callback as the CLI would call it, and a way to emit
 * stream messages; the stream ends (the CLI process exits) when `script` returns.
 */
async function run(script: (api: { ask: Ask; emit: (message: unknown) => void; sent: NormalizedMessage[] }) => Promise<void>): Promise<NormalizedMessage[]> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-approvals-'));
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const queue: unknown[] = [];
  let wake = null as (() => void) | null;
  let ended = false;
  const sdk: { canUseTool?: (name: string, input: unknown, options: unknown) => Promise<unknown> } = {};

  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: (({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { canUseTool?: typeof sdk.canUseTool } }) => {
      sdk.canUseTool = options.canUseTool;
      void (async () => { for await (const _m of prompt) { /* stdin */ } })();
      const iterator = (async function* () {
        for (;;) {
          if (queue.length === 0) {
            if (ended) return;
            await new Promise<void>((resolve) => { wake = resolve; });
            wake = null;
            continue;
          }
          yield queue.shift();
        }
      })();
      return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
    }) as never,
  };

  try {
    const done = queryClaudeSDK('go', { sessionId: SESSION_ID, cwd }, writer as never, context);
    // Wait for the SDK options to be built.
    for (let i = 0; i < 100 && !sdk.canUseTool; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const emit = (message: unknown) => { queue.push(message); wake?.(); };
    emit(init());
    await script({
      ask: (toolName, input, toolUseID) => sdk.canUseTool!(toolName, input, { toolUseID, signal: new AbortController().signal }),
      emit,
      sent,
    });
    ended = true;
    wake?.();
    await done;
    return sent;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};

test('a request that beats the stream still names the subagent that asked', async () => {
  const sent = await run(async ({ ask, emit }) => {
    emit(toolUse('toolu_agent', 'Agent', { description: 'Review the diff', prompt: 'go' }));
    // The approval request arrives before the stream shows the child's call...
    const pending = ask('Bash', { command: 'touch x' }, 'toolu_child');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // ...which then follows.
    emit(toolUse('toolu_child', 'Bash', { command: 'touch x' }, 'toolu_agent'));
    await waitFor(() => claudeRuntime.permissions.listPending(SESSION_ID).length > 0);
    const [request] = claudeRuntime.permissions.listPending(SESSION_ID) as Array<{ requestId: string }>;
    claudeRuntime.permissions.resolve(request.requestId, { allow: true });
    await pending;
  });

  const card = sent.find((message) => message.kind === 'permission_request');
  assert.deepEqual((card?.context as { subagent?: unknown } | undefined)?.subagent, { toolUseId: 'toolu_agent', description: 'Review the diff' });
});

test('a question a subagent asked, left unanswered when the process exits, is retracted', async () => {
  const sent = await run(async ({ ask, emit }) => {
    emit(toolUse('toolu_agent', 'Agent', { description: 'Plan it', prompt: 'go' }));
    emit(toolUse('toolu_q', 'AskUserQuestion', { questions: [] }, 'toolu_agent'));
    void ask('AskUserQuestion', { questions: [] }, 'toolu_q');
    await waitFor(() => claudeRuntime.permissions.listPending(SESSION_ID).length > 0);
    assert.equal(claudeRuntime.permissions.listPending(SESSION_ID).length, 1);
    // The script ends here: the CLI process exits with the question unanswered.
  });

  const request = sent.find((message) => message.kind === 'permission_request');
  const retracted = sent.filter((message) => message.kind === 'permission_cancelled' && message.requestId === request?.requestId);
  assert.equal(retracted.length, 1, 'the page is told the question is gone');
  assert.deepEqual(claudeRuntime.permissions.listPending(SESSION_ID), []);
});

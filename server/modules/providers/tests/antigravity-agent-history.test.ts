import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { readInvokedAgentSpecs } from '@/modules/providers/list/antigravity/antigravity-subagent.js';

const CHILD = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPEC = { Role: 'Independent Reviewer', Prompt: 'Review the diff', TypeName: 'research', Model: 'inherit' };

// Reduced from the reported conversation: a planner invokes several tools,
// with the single-agent invocation third and its singular receipt at step 71.
async function withTranscript(receipt: string | undefined, batch: boolean, run: () => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-agent-history-'));
  const oldRoot = process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
  const row = (step_index: number, content: string) => ({ step_index, source: 'MODEL', type: 'GENERIC', status: 'DONE', content });
  const parent = [
    { step_index: 68, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [
      { name: 'read_file', args: { AbsolutePath: '/tmp/first' } },
      { name: 'run_command', args: { CommandLine: 'example' } },
      { name: 'invoke_subagent', args: batch ? { Subagents: [SPEC] } : SPEC },
      { name: 'read_file', args: { AbsolutePath: '/tmp/last' } },
    ] },
    row(69, 'first body'), row(70, 'command body'),
    ...(receipt === undefined ? [] : [row(71, receipt)]),
    row(72, 'last body'),
    { step_index: 74, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-23T00:00:00Z sender=${CHILD} priority=MESSAGE_PRIORITY_LOW content=Review approved\n</SYSTEM_MESSAGE>` },
  ];
  const child = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Review the diff' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { AbsolutePath: '/tmp/source' } }] },
    row(2, 'source body'),
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Reviewed the source' },
  ];
  try {
    for (const [id, rows] of [['parent', parent], [CHILD, child]] as const) {
      const logs = path.join(root, 'brain', id, '.system_generated', 'logs');
      await fs.mkdir(logs, { recursive: true });
      await fs.writeFile(path.join(logs, 'transcript.jsonl'), rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    }
    process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = root;
    await run();
  } finally {
    if (oldRoot === undefined) delete process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
    else process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = oldRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const batch of [false, true]) {
  test(`${batch ? 'batch' : 'single'} agent history keeps the live card identity, report and activity on repeated reloads`, async () => {
    const receipt = `Created At: x\nCompleted At: y\nCreated the following ${batch ? 'subagents' : 'subagent'}:\n${JSON.stringify({ conversationId: CHILD })}`;
    await withTranscript(receipt, batch, async () => {
      const sessions = new AntigravitySessionsProvider();
      const live = sessions.normalizeMessage({ event: 'step_update', step_update: {
        step_index: 71, state: 'DONE', step_type: 'subagent',
        subagent_info: { subagents: [{ role: SPEC.Role, initial_prompt: SPEC.Prompt, conversation_id: CHILD }] },
      } }, 'parent');
      for (let reload = 0; reload < 2; reload += 1) {
        const { messages } = await sessions.fetchHistory('parent');
        const cards = messages.filter((message) => message.toolName === 'Agent');
        assert.equal(cards.length, 1, 'the invocation must survive a history reload as an Agent card');
        assert.deepEqual(cards.map(({ id, toolId, toolInput }) => ({ id, toolId, toolInput })), live.map(({ id, toolId, toolInput }) => ({ id, toolId, toolInput })));
        assert.equal(cards[0].subagent?.status, 'completed');
        assert.equal(cards[0].subagent?.id, CHILD);
        assert.equal(cards[0].toolResult?.content, 'Review approved');
        assert.deepEqual(cards[0].subagentTools?.map((entry) => entry.kind), ['tool', 'text']);
        const neighbors = messages.filter((message) => message.kind === 'tool_use' && message.toolName !== 'Agent');
        assert.deepEqual(neighbors.map((message) => message.toolResult?.content), ['first body', 'command body', 'last body']);
        assert.equal(messages.some((message) => message.toolName === 'invoke_subagent'), false);
      }
    });
  });
}

for (const receipt of [undefined, 'Created the following subagent:\n{"conversationId":']) {
  test(`${receipt === undefined ? 'missing' : 'damaged'} single-agent receipt does not steal neighboring tool results or guess an agent id`, async () => {
    await withTranscript(receipt, false, async () => {
      const { messages } = await new AntigravitySessionsProvider().fetchHistory('parent');
      const cards = messages.filter((message) => message.toolName === 'Agent');
      assert.equal(cards.length, 1);
      assert.equal(cards[0].toolId, 'tool_71:0');
      assert.equal(cards[0].subagent?.status, 'stopped');
      assert.equal(cards[0].toolResult, undefined);
      const neighbors = messages.filter((message) => message.kind === 'tool_use' && message.toolName !== 'Agent');
      assert.deepEqual(neighbors.map((message) => message.toolResult?.content), ['first body', 'command body', 'last body']);
    });
  });
}

test('single-agent input accepts the recorded shape and rejects unrelated or malformed inputs', () => {
  assert.deepEqual(readInvokedAgentSpecs(SPEC), [{ role: SPEC.Role, prompt: SPEC.Prompt }]);
  for (const invalid of [null, [], 'text', {}, { Model: 'inherit' }, { Role: 1, Prompt: [] }, { ...SPEC, Subagents: {} }]) {
    assert.deepEqual(readInvokedAgentSpecs(invalid), []);
  }
});

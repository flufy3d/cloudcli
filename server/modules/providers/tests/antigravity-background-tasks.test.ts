import assert from 'node:assert/strict';
import test from 'node:test';

import { extractAntigravityBackgroundTasks } from '@/modules/providers/list/antigravity/antigravity-runtime.provider.js';

// Step shapes below are verbatim agy 1.3.1 `--output-format stream-json`
// output. The live stream names a subagent only once its invocation step is
// DONE; a backgrounded run_command stays one ACTIVE `tool` step until the
// command exits, and a finished task reports back as a contentless
// `system_message` step.
const subagentStep = (state: string, conversationIds: Array<string | undefined>) => ({
  conversation_id: 'root', step_index: 2, state, step_type: 'subagent', tool_name: 'invoke_subagent',
  subagent_info: {
    subagents: conversationIds.map((conversationId, index) => ({
      type_name: 'self',
      role: index === 0 ? 'Product Reviewer' : 'Test Runner',
      initial_prompt: 'Review UI',
      ...(conversationId ? { conversation_id: conversationId, log_uri: `file:///brain/${conversationId}` } : {}),
    })),
  },
});

test('a finished invoke_subagent step yields one card per created subagent', () => {
  const tasks = extractAntigravityBackgroundTasks(subagentStep('DONE', ['sub-1', 'sub-2']));
  assert.deepEqual(tasks.map((task) => [task.id, task.toolName, task.command]), [
    ['sub-1', 'Subagent', 'Product Reviewer'],
    ['sub-2', 'Subagent', 'Test Runner'],
  ]);
  assert.ok(tasks.every((task) => typeof task.startedAt === 'number'));
});

test('steps that do not name a running subagent yield no card', () => {
  assert.deepEqual(extractAntigravityBackgroundTasks(subagentStep('ACTIVE', [undefined])), []);
  assert.deepEqual(extractAntigravityBackgroundTasks({
    step_type: 'tool', tool_name: 'run_command', state: 'ACTIVE',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 25' } },
  }), []);
  assert.deepEqual(extractAntigravityBackgroundTasks({ step_type: 'system_message', state: 'DONE' }), []);
  assert.deepEqual(extractAntigravityBackgroundTasks({ step_type: 'subagent', state: 'DONE', subagent_info: { subagents: [null, 'x'] } }), []);
});

// The runtime resolves the agy path once per process, so every run in this
// file shares one stand-in, and each test hands it a script over the env.
let stubPath: Promise<string> | null = null;

function sharedStub(): Promise<string> {
  stubPath ??= (async () => {
    const fsSync = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), 'agy-bg-stub-')), 'agy');
    fsSync.writeFileSync(file, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.3.1'); process.exit(0); }
const { events, exitOnEof } = JSON.parse(process.env.AGY_STUB_SCRIPT);
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {});
process.stdin.on('end', () => { if (exitOnEof) process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
(async () => {
  for (const event of events) {
    if (typeof event === 'number') await new Promise((r) => setTimeout(r, event));
    else console.log(JSON.stringify(event));
  }
})();
`, { mode: 0o755 });
    return file;
  })();
  return stubPath;
}

/** Runs `run` with agy replaced by a stand-in that prints `events` (numbers are delays). */
async function withStub<T>(
  events: Array<Record<string, unknown> | number>,
  run: () => Promise<T>,
  exitOnEof = true,
): Promise<T> {
  const oldPath = process.env.CLOUDCLI_ANTIGRAVITY_PATH;
  process.env.CLOUDCLI_ANTIGRAVITY_PATH = await sharedStub();
  process.env.AGY_STUB_SCRIPT = JSON.stringify({ events, exitOnEof });
  try {
    return await run();
  } finally {
    delete process.env.AGY_STUB_SCRIPT;
    if (oldPath) process.env.CLOUDCLI_ANTIGRAVITY_PATH = oldPath;
    else delete process.env.CLOUDCLI_ANTIGRAVITY_PATH;
  }
}

async function createRun(sessionId: string) {
  const { AntigravityRuntimeProvider } = await import('@/modules/providers/list/antigravity/antigravity-runtime.provider.js');
  const { AntigravitySessionsProvider } = await import('@/modules/providers/list/antigravity/antigravity-sessions.provider.js');
  const runtime = new AntigravityRuntimeProvider();
  const sessions = new AntigravitySessionsProvider();
  const sent: any[] = [];
  const writer = { userId: null, send: (msg: any) => { sent.push(msg); } };
  const context = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => null,
    normalizeMessage: (raw: any, sid: string | null) => sessions.normalizeMessage(raw, sid),
    isProviderInstalled: async () => true,
  };
  const done = runtime.run('test prompt', { sessionId }, writer as any, context as any);
  const waitForCard = async () => {
    const startedAt = Date.now();
    while (runtime.backgroundTasks.list(sessionId).length === 0 && Date.now() - startedAt < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { runtime, sent, done, waitForCard };
}

const step = (step_update: Record<string, unknown>) => ({ event: 'step_update', step_update });

test('a subagent card shows while the turn waits and clears before the turn completes', async () => {
  await withStub([
    { event: 'init', conversation_id: 'conv-sub', init: { cwd: '/tmp' } },
    step({ ...subagentStep('ACTIVE', [undefined]), conversation_id: 'conv-sub' }),
    step({ ...subagentStep('DONE', ['subagent-999']), conversation_id: 'conv-sub' }),
    step({ conversation_id: 'conv-sub', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Waiting for subagent\n' }),
    400,
    step({ conversation_id: 'conv-sub', step_index: 4, state: 'DONE', step_type: 'system_message' }),
    step({ conversation_id: 'conv-sub', step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'Review finished.\n' }),
    { event: 'result', result: { conversation_id: 'conv-sub', status: 'SUCCESS', num_turns: 1, usage: { total_tokens: 88 } } },
  ], async () => {
    const { runtime, sent, done, waitForCard } = await createRun('conv-sub');
    await waitForCard();
    assert.deepEqual(runtime.backgroundTasks.list('conv-sub').map((task) => [task.id, task.command]), [['subagent-999', 'Product Reviewer']]);
    assert.equal(sent.some((msg) => msg.kind === 'complete'), false, 'agy holds its result while the subagent runs');

    await done;
    assert.deepEqual(runtime.backgroundTasks.list('conv-sub'), []);
    const statuses = sent.filter((msg) => msg.kind === 'status' && msg.text === 'background_tasks');
    assert.deepEqual(statuses.map((msg) => msg.backgroundTasks.length), [1, 0]);
    const clearedAt = sent.indexOf(statuses.at(-1));
    const completeAt = sent.findIndex((msg) => msg.kind === 'complete');
    assert.ok(clearedAt < completeAt, 'the client must not see a finished turn that still has a card');
  });
});

test('abort clears subagent cards and stops the process', async () => {
  await withStub([
    { event: 'init', conversation_id: 'conv-abort', init: { cwd: '/tmp' } },
    step({ ...subagentStep('DONE', ['subagent-abort-1']), conversation_id: 'conv-abort' }),
  ], async () => {
    const { runtime, done, waitForCard } = await createRun('conv-abort');
    await waitForCard();
    assert.equal(runtime.backgroundTasks.list('conv-abort').length, 1);
    assert.equal(await runtime.abort('conv-abort'), true);
    assert.equal(runtime.backgroundTasks.list('conv-abort').length, 0);
    assert.equal((await done as any).aborted, true);
  }, false);
});

test('an interrupted-stream result keeps the subagent cards of the resumed turn', async () => {
  const interrupted = 'The stream was interrupted. Please continue the task you were working on.';
  await withStub([
    { event: 'init', conversation_id: 'conv-resume', init: { cwd: '/tmp' } },
    step({ ...subagentStep('DONE', ['subagent-r']), conversation_id: 'conv-resume' }),
    { event: 'result', result: { conversation_id: 'conv-resume', status: 'ERROR', error: interrupted } },
    400,
    { event: 'result', result: { conversation_id: 'conv-resume', status: 'SUCCESS' } },
  ], async () => {
    const { runtime, done, waitForCard } = await createRun('conv-resume');
    await waitForCard();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(runtime.backgroundTasks.list('conv-resume').length, 1, 'agy resumes the turn itself');
    await done;
    assert.deepEqual(runtime.backgroundTasks.list('conv-resume'), []);
  });
});

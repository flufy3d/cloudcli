import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAntigravityBackgroundTasks,
  isAntigravityTaskCompletionMessage,
} from '@/modules/providers/list/antigravity/antigravity-runtime.provider.js';

test('extractAntigravityBackgroundTasks extracts subagent when invoke_subagent outputs conversationId', () => {
  const step = {
    step_type: 'tool',
    tool_name: 'invoke_subagent',
    tool_info: {
      parameters: {
        Subagents: [
          {
            Role: 'Product Reviewer',
            Prompt: 'Evaluate UX flow',
            TypeName: 'research',
          },
        ],
      },
      output: `Created the following subagents:
{
  "conversationId": "c7f7910d-d6ff-4606-a373-6d79c59fbb72",
  "workspaceUris": ["/tmp/test"]
}`,
    },
    state: 'DONE',
  };

  const tasks = extractAntigravityBackgroundTasks(step);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'c7f7910d-d6ff-4606-a373-6d79c59fbb72');
  assert.equal(tasks[0].toolName, 'Subagent');
  assert.equal(tasks[0].command, 'Product Reviewer');
  assert.equal(tasks[0].description, 'Product Reviewer');
  assert.ok(typeof tasks[0].startedAt === 'number');
});

test('extractAntigravityBackgroundTasks extracts all parallel subagents when multiple are invoked', () => {
  const step = {
    step_type: 'tool',
    tool_name: 'invoke_subagent',
    tool_info: {
      parameters: {
        Subagents: [
          { Role: 'Product Reviewer', Prompt: 'Evaluate UX', TypeName: 'research' },
          { Role: 'Test Runner', Prompt: 'Run tests', TypeName: 'research' },
        ],
      },
      output: `Created the following subagents:
{
  "conversationId": "sub-1",
  "workspaceUris": ["/tmp/1"]
}
{
  "conversationId": "sub-2",
  "workspaceUris": ["/tmp/2"]
}`,
    },
    state: 'DONE',
  };

  const tasks = extractAntigravityBackgroundTasks(step);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, 'sub-1');
  assert.equal(tasks[0].command, 'Product Reviewer');
  assert.equal(tasks[1].id, 'sub-2');
  assert.equal(tasks[1].command, 'Test Runner');
});

test('extractAntigravityBackgroundTasks extracts background command when run_command runs in background', () => {
  const step = {
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: {
      parameters: {
        CommandLine: 'npm run test:client',
        Cwd: '/tmp/workspace',
      },
      output: `Tool is running as a background task with task id: c34878e4-task-4
Task Description: npm run test:client`,
    },
    state: 'RUNNING',
  };

  const tasks = extractAntigravityBackgroundTasks(step);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'c34878e4-task-4');
  assert.equal(tasks[0].toolName, 'Command');
  assert.equal(tasks[0].command, 'npm run test:client');
  assert.ok(typeof tasks[0].startedAt === 'number');
});

test('isAntigravityTaskCompletionMessage detects completion for subagents and background tasks', () => {
  const subagentCompletion = `The following is a <SYSTEM_MESSAGE> not actually sent by the user.
<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-28T07:23:28Z sender=c7f7910d-d6ff-4606-a373-6d79c59fbb72 priority=MESSAGE_PRIORITY_HIGH content=Review finished
</SYSTEM_MESSAGE>`;

  const commandCompletion = `The following is a <SYSTEM_MESSAGE> not actually sent by the user.
<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-28T05:15:38Z sender=c34878e4-task-4 priority=MESSAGE_PRIORITY_HIGH content=Task id "c34878e4-task-4" finished with result: 0
</SYSTEM_MESSAGE>`;

  const unrelatedMessage = `Hello from user`;

  assert.equal(
    isAntigravityTaskCompletionMessage(subagentCompletion, 'c7f7910d-d6ff-4606-a373-6d79c59fbb72'),
    true,
  );
  assert.equal(
    isAntigravityTaskCompletionMessage(commandCompletion, 'c34878e4-task-4'),
    true,
  );
  assert.equal(
    isAntigravityTaskCompletionMessage(unrelatedMessage, 'c34878e4-task-4'),
    false,
  );
  assert.equal(
    isAntigravityTaskCompletionMessage(subagentCompletion, 'different-task-id'),
    false,
  );
});

test('AntigravityRuntimeProvider holds open for subagent and only completes after subagent finishes', async () => {
  const fsSync = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { AntigravityRuntimeProvider } = await import(
    '@/modules/providers/list/antigravity/antigravity-runtime.provider.js'
  );
  const { AntigravitySessionsProvider } = await import(
    '@/modules/providers/list/antigravity/antigravity-sessions.provider.js'
  );

  const stubDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'agy-bg-stub-'));
  const stubPath = path.join(stubDir, 'agy');

  const stubScript = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('1.0.0');
  process.exit(0);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.exit(0);
});

console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-subagent-test', init: { cwd: '/tmp' } }));

// Emit invoke_subagent tool result
console.log(JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'conv-subagent-test',
    step_index: 1,
    step_type: 'tool',
    tool_name: 'invoke_subagent',
    tool_info: {
      parameters: {
        Subagents: [{ Role: 'Product Reviewer', Prompt: 'Review UI', TypeName: 'research' }]
      },
      output: 'Created the following subagents:\\n{\\n  "conversationId": "subagent-999",\\n  "workspaceUris": ["/tmp"]\\n}'
    },
    state: 'DONE'
  }
}));

// Emit root agent turn result - subagent is still active!
console.log(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'conv-subagent-test',
    status: 'SUCCESS',
    usage: { total_tokens: 42 }
  }
}));

// After 400ms, subagent sends completion
setTimeout(() => {
  console.log('<SYSTEM_MESSAGE>');
  console.log('[Message] timestamp=2026-09-28T07:23:28Z sender=subagent-999 priority=MESSAGE_PRIORITY_HIGH content=Review finished');
  console.log('</SYSTEM_MESSAGE>');

  // Root agent wakes up, outputs follow-up response and emits final result
  setTimeout(() => {
    console.log(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-subagent-test',
        step_index: 2,
        step_type: 'agent_response',
        text_delta: 'Subagent completed the review.'
      }
    }));
    console.log(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-subagent-test',
        status: 'SUCCESS',
        usage: { total_tokens: 88 }
      }
    }));
  }, 50);
}, 400);
`;

  fsSync.writeFileSync(stubPath, stubScript, { mode: 0o755 });

  const oldPath = process.env.CLOUDCLI_ANTIGRAVITY_PATH;
  process.env.CLOUDCLI_ANTIGRAVITY_PATH = stubPath;

  try {
    const runtime = new AntigravityRuntimeProvider();
    assert.ok(runtime.backgroundTasks, 'runtime should expose backgroundTasks facet');

    const sessions = new AntigravitySessionsProvider();
    const sentMessages: any[] = [];
    let completeReceived = false;

    const writer = {
      userId: null,
      send: (msg: any) => {
        sentMessages.push(msg);
        if (msg.kind === 'complete') {
          completeReceived = true;
        }
      },
    };

    const context = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => null,
      normalizeMessage: (raw: any, sid: string | null) => sessions.normalizeMessage(raw, sid),
      isProviderInstalled: async () => true,
    };

    const runPromise = runtime.run('test prompt', { sessionId: 'conv-subagent-test' }, writer as any, context as any);

    // Wait until background task is detected (up to 2000ms)
    const startTime = Date.now();
    while (runtime.backgroundTasks.list('conv-subagent-test').length === 0) {
      if (Date.now() - startTime > 2000) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    // result has been emitted by agy stub, but subagent is still running!
    const activeTasks = runtime.backgroundTasks.list('conv-subagent-test');
    assert.equal(activeTasks.length, 1, 'Should track 1 active background task');
    assert.equal(activeTasks[0].id, 'subagent-999');
    assert.equal(activeTasks[0].command, 'Product Reviewer');

    // complete must NOT have been received yet!
    assert.equal(completeReceived, false, 'complete must NOT be emitted while subagent is running');

    // Now wait for subagent to finish (after 400ms in stub) and the run to settle
    await runPromise;

    // Now complete should have been received
    assert.equal(completeReceived, true, 'complete should be emitted after subagent finishes');

    // Tasks should now be empty
    const tasksAfter = runtime.backgroundTasks.list('conv-subagent-test');
    assert.equal(tasksAfter.length, 0, 'Should have 0 active background tasks after completion');

    // Verify background_tasks status messages were broadcasted
    const bgStatusMessages = sentMessages.filter(
      (m) => m.kind === 'status' && m.text === 'background_tasks',
    );
    assert.ok(bgStatusMessages.length >= 2, 'Should broadcast background_tasks on start and on finish');
    assert.equal(bgStatusMessages[0].backgroundTasks.length, 1);
    assert.equal(bgStatusMessages[bgStatusMessages.length - 1].backgroundTasks.length, 0);
  } catch (err) {
    console.error('Test failed with error:', err);
    throw err;
  } finally {
    if (oldPath) {
      process.env.CLOUDCLI_ANTIGRAVITY_PATH = oldPath;
    } else {
      delete process.env.CLOUDCLI_ANTIGRAVITY_PATH;
    }
  }
});

test('AntigravityRuntimeProvider abort clears background tasks and stops process', async () => {
  const fsSync = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { AntigravityRuntimeProvider } = await import(
    '@/modules/providers/list/antigravity/antigravity-runtime.provider.js'
  );
  const { AntigravitySessionsProvider } = await import(
    '@/modules/providers/list/antigravity/antigravity-sessions.provider.js'
  );

  const stubDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'agy-abort-stub-'));
  const stubPath = path.join(stubDir, 'agy');

  const stubScript = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('1.0.0');
  process.exit(0);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {});
process.stdin.resume();

console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-abort-test', init: { cwd: '/tmp' } }));

// Emit invoke_subagent tool result
console.log(JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'conv-abort-test',
    step_index: 1,
    step_type: 'tool',
    tool_name: 'invoke_subagent',
    tool_info: {
      parameters: {
        Subagents: [{ Role: 'Product Reviewer', Prompt: 'Review UI', TypeName: 'research' }]
      },
      output: 'Created the following subagents:\\n{\\n  "conversationId": "subagent-abort-1",\\n  "workspaceUris": ["/tmp"]\\n}'
    },
    state: 'DONE'
  }
}));

// Emit root agent turn result - subagent is active
console.log(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'conv-abort-test',
    status: 'SUCCESS',
    usage: { total_tokens: 42 }
  }
}));

// Keep process open indefinitely until SIGTERM
process.on('SIGTERM', () => {
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

  fsSync.writeFileSync(stubPath, stubScript, { mode: 0o755 });

  const oldPath = process.env.CLOUDCLI_ANTIGRAVITY_PATH;
  process.env.CLOUDCLI_ANTIGRAVITY_PATH = stubPath;

  try {
    const runtime = new AntigravityRuntimeProvider();
    const sessions = new AntigravitySessionsProvider();
    const writer = {
      userId: null,
      send: () => {},
    };

    const context = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => null,
      normalizeMessage: (raw: any, sid: string | null) => sessions.normalizeMessage(raw, sid),
      isProviderInstalled: async () => true,
    };

    const runPromise = runtime.run('test prompt', { sessionId: 'conv-abort-test' }, writer as any, context as any);

    // Wait until background task is detected (up to 2000ms)
    const startTime = Date.now();
    while (runtime.backgroundTasks.list('conv-abort-test').length === 0) {
      if (Date.now() - startTime > 2000) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(runtime.backgroundTasks.list('conv-abort-test').length, 1);

    // Now abort the session
    const aborted = await runtime.abort('conv-abort-test');
    assert.equal(aborted, true, 'abort should return true for running session');

    // Background tasks must be cleared immediately
    assert.equal(runtime.backgroundTasks.list('conv-abort-test').length, 0);

    // Run promise should settle
    const outcome = await runPromise as any;
    assert.equal(outcome.aborted, true);
  } finally {
    if (oldPath) {
      process.env.CLOUDCLI_ANTIGRAVITY_PATH = oldPath;
    } else {
      delete process.env.CLOUDCLI_ANTIGRAVITY_PATH;
    }
  }
});



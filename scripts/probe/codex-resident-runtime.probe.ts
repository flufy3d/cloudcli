/**
 * Probe: the whole resident path, against the real engine.
 *
 * The other probe drives the session manager directly. This one drives the
 * Codex runtime, so the parts the runtime adds are covered too: the queue
 * submission with the round's settings, the round's events, the terminal
 * event, and the second round in the same process and thread.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json scripts/probe/codex-resident-runtime.probe.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startFakeModel } from './resident-fake-model.js';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

async function main() {
  const model = startFakeModel();
  await model.listening;

  const home = mkdtempSync(path.join(tmpdir(), 'codex-runtime-home-'));
  const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-runtime-cfg-'));
  writeFileSync(path.join(codexHome, 'config.toml'), `
model = "probe-model"
model_provider = "probe"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.probe]
name = "probe"
base_url = "http://127.0.0.1:${model.port()}/v1"
env_key = "PROBE_API_KEY"
wire_api = "responses"
`);

  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
  process.env.PROBE_API_KEY = 'probe-key';
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';

  const { codexRuntime } = await import('@/modules/providers/list/codex/codex-runtime.provider.js');
  const { closeCodexResidentSessions, listCodexResidentSessions } = await import('@/modules/providers/list/codex/codex-session-manager.js');

  const firstMessages: any[] = [];
  const secondMessages: any[] = [];
  const { CodexSessionsProvider } = await import('@/modules/providers/list/codex/codex-sessions.provider.js');
  const sessions = new CodexSessionsProvider();
  let resolvedThreadId: string | null = null;
  const context = {
    resolveProviderSessionId: () => resolvedThreadId,
    resolveResumeModel: async () => 'probe-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'probe-model' }),
    normalizeMessage: (row: unknown, sessionId: string | null) => sessions.normalizeMessage(row, sessionId),
    isProviderInstalled: async () => true,
  };

  try {
    const first = await codexRuntime.run('FIRST-RUNTIME-PROBE-TEXT', {
      sessionId: 'probe-runtime-session',
      cwd: REPO_ROOT,
      model: 'probe-model',
    }, { isWebSocketWriter: true, send: (message: any) => firstMessages.push(message) }, context as never);

    const firstResident = listCodexResidentSessions()[0];
    const second = await codexRuntime.run('SECOND-RUNTIME-PROBE-TEXT', {
      sessionId: 'probe-runtime-session',
      cwd: REPO_ROOT,
      model: 'probe-model',
    }, { isWebSocketWriter: true, send: (message: any) => secondMessages.push(message) }, context as never);

    const firstReply = firstMessages.find((message) => message.kind === 'assistant' || message.kind === 'text');
    const secondReply = secondMessages.find((message) => message.kind === 'assistant' || message.kind === 'text');
    const firstComplete = firstMessages.find((message) => message.kind === 'complete');
    const secondComplete = secondMessages.find((message) => message.kind === 'complete');

    const secondResident = listCodexResidentSessions()[0];
    assert.ok(firstReply && secondReply, 'both rounds must deliver normalized assistant replies');
    assert.equal(firstComplete?.exitCode, 0);
    assert.equal(secondComplete?.exitCode, 0);
    assert.equal(firstResident.generation, secondResident.generation);
    assert.equal(firstResident.threadId, secondResident.threadId);
    assert.ok(model.requests.some((body) => body.includes('FIRST-RUNTIME-PROBE-TEXT')));
    assert.ok(model.requests.some((body) => body.includes('SECOND-RUNTIME-PROBE-TEXT')));

    resolvedThreadId = secondResident.threadId;
    const taskMessages: any[] = [];
    let taskGeneration: number | undefined;
    const taskResult = await codexRuntime.run('', {
      sessionId: 'probe-runtime-session', cwd: REPO_ROOT, model: 'probe-model',
      taskContinuation: { eventId: 'RESIDENT-TASK-RESULT-PROBE', taskId: 'probe-task', summary: 'probe completed' },
    }, {
      isWebSocketWriter: true,
      send: (message: any) => {
        taskMessages.push(message);
        taskGeneration ??= listCodexResidentSessions()[0]?.generation;
      },
    }, context as never);
    assert.equal(taskResult.terminalStatus, 'completed');
    assert.equal(taskMessages.find((message) => message.kind === 'complete')?.exitCode, 0);
    assert.ok(taskGeneration !== undefined && taskGeneration !== secondResident.generation);
    assert.equal(listCodexResidentSessions().length, 0, 'the tool-result process must be released');
    assert.ok(model.requests.some((body) => body.includes('RESIDENT-TASK-RESULT-PROBE')));

    const resumedMessages: any[] = [];
    const resumed = await codexRuntime.run('AFTER-TASK-RUNTIME-PROBE', {
      sessionId: 'probe-runtime-session', cwd: REPO_ROOT, model: 'probe-model',
    }, { isWebSocketWriter: true, send: (message: any) => resumedMessages.push(message) }, context as never);
    assert.equal(resumed.terminalStatus, 'completed');
    assert.equal(resumedMessages.find((message) => message.kind === 'complete')?.exitCode, 0);
    const resumedResident = listCodexResidentSessions()[0];
    assert.equal(resumedResident.threadId, firstResident.threadId);
    assert.notEqual(resumedResident.generation, taskGeneration);

    const { listCodexThreadTurns } = await import('@/modules/providers/list/codex/codex-app-server.client.js');
    const history = await listCodexThreadTurns(resumedResident.threadId) as Array<{ id: string; items: any[] }>;
    const resultTurns = history.filter((turn) => turn.items.some((item) => item.type === 'functionCallOutput'
      && item.name === 'cloudcli_task_result' && JSON.stringify(item.output).includes('RESIDENT-TASK-RESULT-PROBE')));
    assert.equal(resultTurns.length, 1, 'one persisted native tool result must identify the continuation');
    assert.equal(resultTurns[0].id, taskResult.engineTurnId);

    console.log('\n### the resident path through the real engine');
    console.log(JSON.stringify({
      firstRound: {
        engineTurnId: (first as { engineTurnId?: string } | null)?.engineTurnId ?? null,
        terminalStatus: (first as { terminalStatus?: string } | null)?.terminalStatus ?? null,
        sawReply: Boolean(firstReply),
        sawComplete: Boolean(firstComplete),
        completeExitCode: (firstComplete as { exitCode?: number } | null)?.exitCode ?? null,
      },
      secondRound: {
        engineTurnId: (second as { engineTurnId?: string } | null)?.engineTurnId ?? null,
        terminalStatus: (second as { terminalStatus?: string } | null)?.terminalStatus ?? null,
        sawReply: Boolean(secondReply),
        sawComplete: Boolean(secondComplete),
      },
      toolResult: {
        terminalStatus: taskResult.terminalStatus,
        usedFreshProcess: taskGeneration !== secondResident.generation,
        processReleased: true,
        persistedInOwnNativeTurn: resultTurns[0].id === taskResult.engineTurnId,
        reachedModel: model.requests.some((body) => body.includes('RESIDENT-TASK-RESULT-PROBE')),
      },
      afterToolResult: { terminalStatus: resumed.terminalStatus, sameNativeThread: resumedResident.threadId === firstResident.threadId },
      sameThread: firstResident.threadId === secondResident.threadId,
      sameProcessGeneration: firstResident.generation === secondResident.generation,
      firstMessageKinds: firstMessages.map((message) => message.kind),
      secondMessageKinds: secondMessages.map((message) => message.kind),
      errors: [...firstMessages, ...secondMessages]
        .filter((message) => message.kind === 'error')
        .map((message) => message.content),
      modelReceivedBothInputs: [
        model.requests.some((body) => body.includes('FIRST-RUNTIME-PROBE-TEXT')),
        model.requests.some((body) => body.includes('SECOND-RUNTIME-PROBE-TEXT')),
      ],
    }, null, 2));
  } finally {
    closeCodexResidentSessions();
    await model.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(codexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

void main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

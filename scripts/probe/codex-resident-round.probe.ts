/**
 * Probe: one round through the resident session manager and the real engine.
 *
 * The unit tests drive the manager with a fake transport. This probe drives
 * the packaged `codex app-server` for real, with the model replaced by a
 * local endpoint that answers with a fixed message, and checks the round
 * that goes through the engine's queue: the input is submitted, the engine
 * starts a turn of its own, and the round's events arrive.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json scripts/probe/codex-resident-round.probe.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startFakeModel } from './resident-fake-model.js';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const model = startFakeModel();
  await model.listening;

  const home = mkdtempSync(path.join(tmpdir(), 'codex-resident-home-'));
  const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-resident-cfg-'));
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

  const {
    acquireCodexResidentSession,
    closeCodexResidentSessions,
    completeCodexResidentRound,
    submitCodexResidentRound,
  } = await import('@/modules/providers/list/codex/codex-session-manager.js');

  const events: string[] = [];
  let turnId: string | null = null;

  try {
    const session = await acquireCodexResidentSession({
      appSessionId: 'probe-session',
      nativeThreadId: null,
      workingDirectory: REPO_ROOT,
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
      onEngineEvent: (method) => events.push(`engine:${method}`),
    });

    await submitCodexResidentRound({
      appSessionId: 'probe-session',
      input: [{ type: 'text', text: 'RESIDENT-PROBE-TEXT' }],
      // The round carries the same settings the runtime sends, so the probe
      // fails the way the runtime would when the protocol shapes are wrong.
      model: 'probe-model',
      effort: 'medium',
      workingDirectory: REPO_ROOT,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEvent: (method) => {
        events.push(`round:${method}`);
        if (method === 'turn/started') {
          turnId = 'started';
        }
      },
      onRequest: () => undefined,
    });

    // The engine starts the queued input as a turn of its own.
    for (let attempt = 0; attempt < 100 && !events.includes('round:turn/completed'); attempt += 1) {
      await sleep(100);
    }

    const delivered = model.requests.some((body) => body.includes('RESIDENT-PROBE-TEXT'));

    // The next round continues in the same process and the same thread.
    completeCodexResidentRound('probe-session');
    const secondEvents: string[] = [];
    await submitCodexResidentRound({
      appSessionId: 'probe-session',
      input: [{ type: 'text', text: 'SECOND-RESIDENT-PROBE-TEXT' }],
      model: 'probe-model',
      effort: 'medium',
      workingDirectory: REPO_ROOT,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      onEvent: (method) => secondEvents.push(method),
      onRequest: () => undefined,
    });
    for (let attempt = 0; attempt < 100 && !secondEvents.includes('turn/completed'); attempt += 1) {
      await sleep(100);
    }
    const secondDelivered = model.requests.some((body) => body.includes('SECOND-RESIDENT-PROBE-TEXT'));

    assert.ok(delivered && secondDelivered, 'both inputs must reach the model');
    assert.ok(events.includes('round:turn/started') && events.includes('round:turn/completed'));
    assert.ok(secondEvents.includes('turn/started') && secondEvents.includes('turn/completed'));

    console.log('\n### the round through the real engine');
    console.log(JSON.stringify({
      threadId: session.threadId,
      roundSawTurnStarted: events.includes('round:turn/started'),
      roundSawTurnCompleted: events.includes('round:turn/completed'),
      engineEvents: events.filter((event) => event.startsWith('engine:')),
      modelReceivedTheInput: delivered,
      secondRoundEvents: secondEvents,
      secondRoundReachedTheModel: secondDelivered,
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

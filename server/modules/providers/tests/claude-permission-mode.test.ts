import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime must send `permissionMode` to the SDK on every run. An omitted
 * value used to mean "the SDK's own default, manual approvals"; since SDK
 * 0.3.286 it defers to the CLI settings' `defaultMode`, which can silently
 * start sessions in an auto-approving mode. Pinning 'default' here is what
 * keeps the approval card the baseline.
 */

const SESSION_ID = 'app-permission-session';
const NATIVE_ID = 'native-permission-session';

test('a run without permissionMode pins the SDK default mode', async () => {
  const captured = await runAndCapture({});
  assert.equal(captured.permissionMode, 'default');
});

test('an explicit default mode also pins the SDK default mode', async () => {
  const captured = await runAndCapture({ permissionMode: 'default' });
  assert.equal(captured.permissionMode, 'default');
});

test('a non-default mode is forwarded unchanged', async () => {
  const captured = await runAndCapture({ permissionMode: 'plan' });
  assert.equal(captured.permissionMode, 'plan');
});

/** Drives one scripted run and returns the options the runtime handed the SDK. */
async function runAndCapture(turnOptions: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-permission-mode-'));
  let capturedOptions: Record<string, unknown> | null = null;
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ options }) => {
    capturedOptions = options as Record<string, unknown>;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: NATIVE_ID };
      yield { type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1 };
    })() as never;
  };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => [] as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  try {
    await queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd, ...turnOptions }, writer as never, context);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  assert.ok(capturedOptions, 'the runtime never reached the SDK query');
  return capturedOptions as Record<string, unknown>;
}

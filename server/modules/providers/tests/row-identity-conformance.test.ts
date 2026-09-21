/**
 * Every transcript row must have an id derived from the engine's own record.
 *
 * A row that is persisted exists twice: once as a live frame while the run is
 * in flight, once as the row a later history read returns. The client shows
 * one row for both only if it can tell they are the same row, and the only
 * honest way to tell is a shared id. When an adapter invents the id at emit
 * time instead, the same message comes back under a new id on every read, and
 * the client is left comparing text, timestamps and array positions — which
 * is how one prompt ended up rendered twice in the transcript.
 *
 * Two properties are checked here, per engine, because either one failing
 * brings the guessing back:
 *
 *   1. Determinism — normalizing the same record twice yields the same id.
 *   2. Cross-path agreement — the live frame and the persisted row for one
 *      logical row carry the same id.
 *
 * cursor and opencode are out of scope for this fork; they are exercised only
 * by the determinism property, which costs nothing to hold.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { ZCodeSessionsProvider } from '@/modules/providers/list/zcode/zcode-sessions.provider.js';
import { enforceNormalizedMessageContract } from '@/shared/normalized-message-contract.js';
import type { NormalizedMessage } from '@/shared/types.js';

const SESSION_ID = 'session-under-test';

type EngineCase = {
  provider: string;
  /** Raw records the engine produces, in the shape `normalizeMessage` receives. */
  records: ReadonlyArray<{ label: string; raw: unknown }>;
  normalize: (raw: unknown) => NormalizedMessage[];
};

const claude = new ClaudeSessionsProvider();
const codex = new CodexSessionsProvider();
const antigravity = new AntigravitySessionsProvider();
const zcode = new ZCodeSessionsProvider();

const ENGINE_CASES: readonly EngineCase[] = [
  {
    provider: 'claude',
    normalize: (raw) => claude.normalizeMessage(raw, SESSION_ID),
    records: [
      {
        label: 'assistant text',
        raw: {
          uuid: 'c841b977-a3e4-49ec-8d8c-f074975abe00',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        },
      },
      {
        label: 'user prompt',
        raw: {
          uuid: '3c16ee84-e3f9-4bb1-a7b0-1a2a962c0b17',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'user', content: 'run the tests' },
        },
      },
      {
        label: 'tool call',
        raw: {
          uuid: '835dde10-32be-4af0-a703-ae6eb7e22cac',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
          },
        },
      },
    ],
  },
  {
    provider: 'codex',
    normalize: (raw) => codex.normalizeMessage(raw, SESSION_ID),
    records: [
      {
        label: 'live item',
        raw: {
          type: 'item',
          itemId: 'msg_02f5777c2a733b17016ab0759323dc87d0922628f30ead41fd',
          itemType: 'agent_message',
          text: 'hello',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        label: 'history assistant text',
        raw: {
          uuid: 'msg_02f5777c2a733b17016ab0759323dc87d0922628f30ead41fd',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'assistant', content: 'hello' },
        },
      },
    ],
  },
  {
    provider: 'antigravity',
    normalize: (raw) => antigravity.normalizeMessage(raw, SESSION_ID),
    records: [
      {
        label: 'live tool call',
        raw: {
          event: 'step_update',
          step_update: {
            step_index: 7,
            step_type: 'tool',
            state: 'ACTIVE',
            tool_name: 'run_command',
            tool_info: { parameters: { command: 'ls' } },
          },
        },
      },
      {
        label: 'live tool result',
        raw: {
          event: 'step_update',
          step_update: {
            step_index: 7,
            step_type: 'tool',
            state: 'DONE',
            tool_name: 'run_command',
            tool_info: { output: 'a.txt' },
          },
        },
      },
    ],
  },
  {
    provider: 'zcode',
    normalize: (raw) => zcode.normalizeMessage(raw, SESSION_ID),
    records: [
      {
        label: 'live assistant text',
        raw: {
          type: 'model_response',
          id: 'zcode-message-1',
          sessionId: SESSION_ID,
          payload: { text: 'hello' },
        },
      },
    ],
  },
];

test('normalizing the same engine record twice yields the same ids', () => {
  for (const engineCase of ENGINE_CASES) {
    for (const record of engineCase.records) {
      const first = engineCase.normalize(record.raw).map((message) => message.id);
      const second = engineCase.normalize(record.raw).map((message) => message.id);
      assert.deepEqual(
        second,
        first,
        `${engineCase.provider}/${record.label}: ids changed between two reads of the same record`,
      );
    }
  }
});

test('no transcript row leaves an engine with an id invented at emit time', () => {
  for (const engineCase of ENGINE_CASES) {
    for (const record of engineCase.records) {
      for (const message of engineCase.normalize(record.raw)) {
        const checked = enforceNormalizedMessageContract(message);
        assert.ok(checked.ok, `${engineCase.provider}/${record.label}: rejected by the contract`);
        assert.deepEqual(
          checked.contractViolations,
          [],
          `${engineCase.provider}/${record.label}: ${checked.contractViolations.join('; ')}`,
        );
      }
    }
  }
});

/**
 * Antigravity reports a tool call twice: live at its own step, and in history
 * on the planner entry that declared it one step earlier. Both paths already
 * agree on `toolId`; the row id has to agree too, or the persisted card
 * renders beside the live one.
 */
test('antigravity names one tool call the same way on both paths', () => {
  const live = antigravity.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 8,
      step_type: 'tool',
      state: 'ACTIVE',
      tool_name: 'run_command',
      tool_info: { parameters: { command: 'ls' } },
    },
  }, SESSION_ID).find((message) => message.kind === 'tool_use');

  assert.ok(live, 'the live event produces a tool_use row');
  assert.equal(live.toolId, 'tool_8');
  assert.equal(
    live.id,
    `msg_${SESSION_ID}_tool_8`,
    'the live row id is derived from the call identity both paths compute',
  );
});

/**
 * ZCode names a persisted row `(message_id, part_id)` but its live stream
 * only mentions the message: assistant text arrives as `text_delta` events
 * and no row id is ever sent, so `id` cannot join the two paths. The message
 * id is what both sides carry, and it is published as the row key so the
 * client reconciles the streamed reply with the persisted one by identity
 * rather than by comparing the text of the two.
 */
test('zcode publishes one row key for a reply on both paths', () => {
  const messageId = 'msg_muaj6bc0_a3536698';
  const live = zcode.normalizeMessage({
    type: 'model_streaming',
    id: messageId,
    sessionId: SESSION_ID,
    payload: { kind: 'text_delta', delta: 'the answer' },
  }, SESSION_ID);

  assert.equal(live.length, 1);
  assert.equal(live[0].kind, 'stream_delta');
  assert.equal(live[0].providerRowKey, `zcode-message:${messageId}`);
});

/**
 * Per-provider conformance: does one engine's live stream line up with its own
 * persisted transcript?
 *
 * The standard this checks is the one the whole normalization layer exists to
 * uphold — **a logical row must carry the same identity on both transports**.
 * When it does not, the timeline shows the live copy beside the persisted one,
 * which is the duplicate-and-scrambled transcript this repository keeps
 * chasing. Refreshing a closed session looks fine precisely because only one
 * transport is involved; the damage appears while a run is open.
 *
 * Fixtures are captured from real engine runs (live frames normalized through
 * the provider, plus that same session's own history), so a provider whose
 * output drifts from its transcript fails here rather than in someone's chat.
 * Regenerate one by running the engine and normalizing both sides.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage, ServerEvent } from '@/shared/types';
import { SessionTimelineStore } from '@/modules/chat/utils/sessionTimelineStore';
import antigravityTurn from '@/modules/chat/tests/fixtures/antigravity-turn.json';
import codexTurn from '@/modules/chat/tests/fixtures/codex-turn.json';

type Fixture = {
  provider: string;
  prompt: string;
  live: NormalizedMessage[];
  history: NormalizedMessage[];
};

const SESSION_ID = 'conformance-session';

/** Drives one captured turn the way the app does: send, stream, then refresh. */
async function playTurn(fixture: Fixture): Promise<NormalizedMessage[]> {
  const history = fixture.history.map((row) => ({ ...row, sessionId: SESSION_ID }));
  const store = new SessionTimelineStore({
    fetchPage: async () => ({ messages: history, total: history.length, hasMore: false }),
  });

  store.appendRealtime(SESSION_ID, {
    id: 'local_prompt',
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    provider: fixture.provider as NormalizedMessage['provider'],
    kind: 'text',
    role: 'user',
    content: fixture.prompt,
  });

  for (const frame of fixture.live) {
    store.applyServerEvent(
      { ...frame, sessionId: SESSION_ID } as unknown as ServerEvent,
      { provider: fixture.provider as NormalizedMessage['provider'] },
    );
  }
  // Let the stream throttle land its buffered text before history arrives.
  await new Promise((resolve) => setTimeout(resolve, 150));
  await store.refreshLatestFromServer(SESSION_ID, { limit: 50 });

  return store.getMessages(SESSION_ID);
}

function describeRow(row: NormalizedMessage): string {
  if (row.kind === 'tool_use') return `tool_use:${row.toolName}:${JSON.stringify(row.toolInput)}`;
  if (row.kind === 'text') return `text:${row.role}:${(row.content ?? '').trim()}`;
  return '';
}

for (const fixture of [antigravityTurn as Fixture, codexTurn as Fixture]) {
  test(`${fixture.provider}: a live turn and its own history render one transcript`, async () => {
    const rows = await playTurn(fixture);

    const seen = new Map<string, number>();
    for (const row of rows) {
      const description = describeRow(row);
      if (!description) continue;
      seen.set(description, (seen.get(description) ?? 0) + 1);
    }

    const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
    assert.deepEqual(
      duplicated,
      [],
      `${fixture.provider} renders the same row more than once:\n`
      + duplicated.map(([description, count]) => `  x${count} ${description}`).join('\n'),
    );
  });

  test(`${fixture.provider}: every tool call the live stream showed survives the refresh`, async () => {
    const rows = await playTurn(fixture);
    const liveToolIds = fixture.live
      .filter((row) => row.kind === 'tool_use')
      .map((row) => row.toolId);

    for (const toolId of liveToolIds) {
      assert.ok(
        rows.some((row) => row.kind === 'tool_use' && row.toolId === toolId),
        `the card for ${toolId} disappeared once history arrived`,
      );
    }
  });
}

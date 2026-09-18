import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SESSION_ID = '0ca3d73a-3d60-439d-8c1b-5a858720b04e';
const SUMMARY_TEXT = 'This session is being continued from a previous conversation that ran out of context.';

/** The system event the live SDK emits when it auto-compacts a session. */
const compactBoundaryEvent = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 180_000 },
  uuid: '51c48717-82e8-4192-83d5-30fcd21e5275',
  session_id: SESSION_ID,
};

/**
 * The live SDK's user message for the summary. `SDKUserMessage` has no
 * `isCompactSummary`/`isMeta` field, so the row is indistinguishable from a
 * typed prompt on its own.
 */
const liveSummaryMessage = {
  type: 'user',
  uuid: '1eaa49de-d0bf-4d41-89b4-46730e5d3528',
  message: { role: 'user', content: [{ type: 'text', text: SUMMARY_TEXT }] },
};

const typedPrompt = (text: string) => ({
  type: 'user',
  uuid: 'b6f1c0de-0000-4000-8000-000000000001',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

test('the persisted summary row is relabeled as assistant-authored summary text', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    { type: 'user', uuid: 'row-1', isCompactSummary: true, message: { role: 'user', content: SUMMARY_TEXT } },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].isCompactSummary, true);
  assert.equal(messages[0].content, SUMMARY_TEXT);
});

test('the live summary is relabeled from the compact_boundary event, not a marker it lacks', () => {
  const provider = new ClaudeSessionsProvider();

  assert.deepEqual(provider.normalizeMessage(compactBoundaryEvent, SESSION_ID), []);
  const messages = provider.normalizeMessage(liveSummaryMessage, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].isCompactSummary, true);
  assert.equal(messages[0].content, SUMMARY_TEXT);
});

test('a prompt arriving without a preceding boundary stays a user message', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(typedPrompt('继续做'), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.notEqual(messages[0].isCompactSummary, true);
});

test('the boundary latch is one-shot, so the prompt after a summary stays a user message', () => {
  const provider = new ClaudeSessionsProvider();

  provider.normalizeMessage(compactBoundaryEvent, SESSION_ID);
  provider.normalizeMessage(liveSummaryMessage, SESSION_ID);
  const messages = provider.normalizeMessage(typedPrompt('继续做'), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.notEqual(messages[0].isCompactSummary, true);
});

test('a boundary latched for one session does not relabel another session prompt', () => {
  const provider = new ClaudeSessionsProvider();

  provider.normalizeMessage(compactBoundaryEvent, SESSION_ID);
  const messages = provider.normalizeMessage(typedPrompt('别的会话'), 'other-session');

  assert.equal(messages[0].role, 'user');
  assert.notEqual(messages[0].isCompactSummary, true);
});

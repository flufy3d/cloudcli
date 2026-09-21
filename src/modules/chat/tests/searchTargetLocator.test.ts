import assert from 'node:assert/strict';

import { test } from 'vitest';

import { findSearchTargetIndex } from '@/modules/chat/utils/searchTargetLocator';
import { groupConsecutiveTools } from '@/modules/chat/utils/toolGrouping';
import type { ChatMessage } from '@/shared/types';

/**
 * The sidebar search jump used to render the whole transcript and then scan the
 * DOM for the snippet. With nothing to identify the hit ahead of time, a miss
 * was indistinguishable from a hit: it scrolled somewhere plausible and flashed
 * the highlight, telling the user they had been taken to their result when they
 * had not.
 *
 * Resolving the index from the message data is what makes a miss detectable —
 * findSearchTargetIndex returns -1 and the jump declines rather than
 * pretending. The index it returns addresses the *grouped* rows the transcript
 * renders, because that is the index space the virtualizer scrolls by; a hit
 * collapsed inside a tool group resolves to the group's row.
 */

const message = (content: string, timestamp: string): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp,
});

const transcript: ChatMessage[] = [
  message('the very first thing we discussed was database indexing', '2024-01-01T10:00:00.000Z'),
  message('then we moved on to caching strategies', '2024-01-01T10:05:00.000Z'),
  message('finally we talked about deployment pipelines', '2024-01-01T10:10:00.000Z'),
];

test('a snippet matches the message that contains it', () => {
  const index = findSearchTargetIndex(transcript, { snippet: 'caching strategies' });
  assert.equal(index, 1);
});

test('snippet matching ignores case', () => {
  const index = findSearchTargetIndex(transcript, { snippet: 'DEPLOYMENT PIPELINES' });
  assert.equal(index, 2);
});

test('the sidebar ellipsis wrapper is stripped before matching', () => {
  const index = findSearchTargetIndex(transcript, { snippet: '...database indexing...' });
  assert.equal(index, 0);
});

test('a snippet that matches nothing reports a miss instead of guessing', () => {
  const index = findSearchTargetIndex(transcript, { snippet: 'something never said here' });
  assert.equal(index, -1, 'a miss must be -1 so the caller can decline to scroll');
});

test('a too-short snippet does not match by accident', () => {
  // Under the minimum length this would match almost anything.
  const index = findSearchTargetIndex(transcript, { snippet: 'the' });
  assert.equal(index, -1);
});

test('the timestamp resolves the target when no snippet is given', () => {
  const index = findSearchTargetIndex(transcript, { timestamp: '2024-01-01T10:05:01.000Z' });
  assert.equal(index, 1);
});

test('the timestamp is only a fallback when the snippet misses', () => {
  const index = findSearchTargetIndex(transcript, {
    snippet: 'not present anywhere',
    timestamp: '2024-01-01T10:10:00.000Z',
  });
  assert.equal(index, 2);
});

test('an empty transcript reports a miss', () => {
  assert.equal(findSearchTargetIndex([], { snippet: 'anything at all here' }), -1);
});

test('a target with neither snippet nor timestamp reports a miss', () => {
  assert.equal(findSearchTargetIndex(transcript, {}), -1);
});

test('tool output is searchable, since it is rendered text', () => {
  const withTool: ChatMessage[] = [
    message('intro text', '2024-01-01T10:00:00.000Z'),
    {
      type: 'assistant',
      content: '',
      timestamp: '2024-01-01T10:01:00.000Z',
      isToolUse: true,
      toolName: 'Bash',
      toolInput: JSON.stringify({ command: 'npm run migrate:database' }),
    },
  ];

  assert.equal(findSearchTargetIndex(withTool, { snippet: 'npm run migrate:database' }), 1);
});

test('a tool result is searchable', () => {
  const withResult: ChatMessage[] = [
    {
      type: 'assistant',
      content: '',
      timestamp: '2024-01-01T10:01:00.000Z',
      toolResult: { content: 'migration applied successfully', isError: false },
    },
  ];

  assert.equal(findSearchTargetIndex(withResult, { snippet: 'migration applied successfully' }), 0);
});

test('an unparsable timestamp does not crash the nearest search', () => {
  const withBadTimestamp: ChatMessage[] = [
    message('first', 'not-a-date'),
    message('second', '2024-01-01T10:00:00.000Z'),
  ];

  assert.equal(findSearchTargetIndex(withBadTimestamp, { timestamp: '2024-01-01T10:00:00.000Z' }), 1);
});

test('only the leading part of an over-long snippet has to match', () => {
  // The sidebar sends an elided fragment; matching is capped at 80 characters,
  // so a hit whose first 80 characters match is found even if the tail differs.
  const head = 'a'.repeat(80);
  const messages: ChatMessage[] = [message(`${head}TAIL-IN-TRANSCRIPT`, '2024-01-01T10:00:00.000Z')];

  assert.equal(findSearchTargetIndex(messages, { snippet: `${head}DIFFERENT-TAIL` }), 0);
});

test('a hit inside a collapsed tool group resolves to the group row', () => {
  // Grouping folds a run of same-tool calls into one rendered row, so the hit's
  // index in the flat message list is NOT the row the viewport must scroll to.
  const messages: ChatMessage[] = [
    message('intro text', '2024-01-01T10:00:00.000Z'),
    ...Array.from({ length: 3 }, (_, i) => ({
      type: 'assistant' as const,
      content: '',
      timestamp: `2024-01-01T10:0${i + 1}:00.000Z`,
      isToolUse: true,
      toolName: 'Bash',
      toolInput: JSON.stringify({ command: i === 2 ? 'npm run migrate:database' : `echo ${i}` }),
    })),
    message('closing remarks about the migration', '2024-01-01T10:05:00.000Z'),
  ];

  const items = groupConsecutiveTools(messages, true);
  assert.equal(items.length, 3, 'intro, one tool group, closing');
  // The hit is the third message of the group, i.e. index 3 of the flat list.
  assert.equal(findSearchTargetIndex(items, { snippet: 'npm run migrate:database' }), 1);
});

test('rows after a collapsed group keep their grouped index', () => {
  const messages: ChatMessage[] = [
    ...Array.from({ length: 4 }, (_, i) => ({
      type: 'assistant' as const,
      content: '',
      timestamp: `2024-01-01T10:0${i}:00.000Z`,
      isToolUse: true,
      toolName: 'Read',
      toolInput: JSON.stringify({ file_path: `/tmp/file-${i}` }),
    })),
    message('the deployment pipeline is now green', '2024-01-01T10:09:00.000Z'),
  ];

  const items = groupConsecutiveTools(messages, true);
  assert.equal(findSearchTargetIndex(items, { snippet: 'deployment pipeline is now green' }), 1);
});

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { buildClaudeToolPermissionEntry } from '@/modules/chat/utils/chatPermissions';

test('buildClaudeToolPermissionEntry derives a scoped git command from JSON input', () => {
  assert.equal(
    buildClaudeToolPermissionEntry('Bash', JSON.stringify({ command: 'git status' })),
    'Bash(git status:*)',
  );
});

test('buildClaudeToolPermissionEntry falls back to the tool name for malformed JSON', () => {
  assert.equal(buildClaudeToolPermissionEntry('Bash', '{"command":'), 'Bash');
});

test('buildClaudeToolPermissionEntry accepts an already parsed tool input', () => {
  assert.equal(buildClaudeToolPermissionEntry('Bash', { command: 'npm test' }), 'Bash(npm:*)');
});

test('buildClaudeToolPermissionEntry rejects JSON with no string command', () => {
  assert.equal(buildClaudeToolPermissionEntry('Bash', JSON.stringify({ command: false })), 'Bash');
});

test('buildClaudeToolPermissionEntry keeps the engine tool name for a subagent spawn', () => {
  // The always-allow rule is written under the name the CLI asked about, so a
  // client-side rename would write a rule that never matches.
  assert.equal(buildClaudeToolPermissionEntry('Agent', JSON.stringify({ prompt: 'go' })), 'Agent');
});

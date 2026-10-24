import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesToolPermission } from '@/modules/providers/list/claude/claude-runtime.provider.js';

test('a saved Task rule still allows the Agent tool the CLI now asks about', () => {
  // Rules saved while the subagent tool was called `Task` stay valid: the CLI
  // resolves the legacy name to `Agent` in its own rule matching, and the app's
  // matcher must agree or the same call would ask for approval twice.
  assert.equal(matchesToolPermission('Task', 'Agent', {}), true);
  assert.equal(matchesToolPermission('Agent', 'Agent', {}), true);
  assert.equal(matchesToolPermission('Agent', 'Task', {}), true);
});

test('task-list tools are not confused with the subagent tool', () => {
  assert.equal(matchesToolPermission('Task', 'TaskCreate', {}), false);
  assert.equal(matchesToolPermission('TaskCreate', 'Agent', {}), false);
});

test('the Bash command shorthand still matches by prefix', () => {
  assert.equal(matchesToolPermission('Bash(git status:*)', 'Bash', { command: 'git status -s' }), true);
});

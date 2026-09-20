import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { getClaudeExternalReadOnlyRoots } from '@/modules/providers/list/claude/claude-data-root.js';

/**
 * The File Tree allowlist may expose Claude's per-project artifacts referenced
 * from chat, but it must not expose credentials and settings beside them in
 * the wider ~/.claude tree.
 */
test('getClaudeExternalReadOnlyRoots exposes only the Claude projects directory', () => {
  assert.deepEqual(getClaudeExternalReadOnlyRoots(), [
    path.join(os.homedir(), '.claude', 'projects'),
  ]);
});

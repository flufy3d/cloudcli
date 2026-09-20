import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isInfrastructureWorkspacePath } from '@/shared/utils.js';

test('isInfrastructureWorkspacePath rejects package-manager stores and temp roots', () => {
  // pnpm virtual store of the deployed build (one new directory per deploy).
  assert.equal(
    isInfrastructureWorkspacePath(
      '/Users/azrael/Library/pnpm/global/5/.pnpm/cloudcli@file+..+cloudcli-2.4.1.tgz_@anthropic-ai+sdk@0.120.0_x/node_modules/cloudcli'
    ),
    true,
  );
  // Any node_modules segment.
  assert.equal(isInfrastructureWorkspacePath('/srv/app/node_modules/fixtures/demo'), true);
  // System temp roots, including macOS os.tmpdir() and its /private prefix.
  assert.equal(isInfrastructureWorkspacePath(path.join(os.tmpdir(), 'probe-ws-abc')), true);
  assert.equal(isInfrastructureWorkspacePath('/var/folders/8d/T/tmp.P0y7IJ0uww'), true);
  assert.equal(isInfrastructureWorkspacePath('/tmp/agy-repro'), true);
  assert.equal(isInfrastructureWorkspacePath('/private/tmp/agy-repro'), true);
  // Empty / whitespace-only paths are treated as infrastructure.
  assert.equal(isInfrastructureWorkspacePath(''), true);
  assert.equal(isInfrastructureWorkspacePath('   '), true);
});

test('isInfrastructureWorkspacePath keeps real user projects', () => {
  assert.equal(isInfrastructureWorkspacePath('/Users/azrael/workspaces/cloudcli'), false);
  assert.equal(isInfrastructureWorkspacePath('/Users/azrael/workspaces/MirLite'), false);
  // Trailing slashes must not break the match.
  assert.equal(isInfrastructureWorkspacePath('/home/dev/my-project/'), false);
  // A directory merely named similarly is not a false positive.
  assert.equal(isInfrastructureWorkspacePath('/srv/node_modules-archives/projects'), false);
  assert.equal(isInfrastructureWorkspacePath('/srv/tmp-files/workspaces'), false);
});

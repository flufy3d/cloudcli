import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexProviderModels } from '../list/codex/codex-models.provider.js';
import { CodexSessionSynchronizer } from '../list/codex/codex-session-synchronizer.provider.js';
import { CodexProviderAuth } from '../list/codex/codex-auth.provider.js';

test('Codex credential status reads the same alternate CODEX_HOME as the engine', async () => {
  const previous = process.env.CODEX_HOME;
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-auth-status-'));
  process.env.CODEX_HOME = directory;
  try {
    await writeFile(path.join(directory, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-not-a-secret' }));
    const auth = new CodexProviderAuth();
    assert.equal((await auth.getStatus()).method, 'api_key');
    await writeFile(path.join(directory, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-not-a-token' } }));
    assert.equal((await auth.getStatus()).method, 'credentials_file');
    await writeFile(path.join(directory, 'config.toml'), 'model = "alternate-chat"\n');
    assert.equal((await new CodexProviderModels().getCurrentActiveModel()).model, 'alternate-chat');
    assert.equal(new CodexSessionSynchronizer().getSessionWatchTarget().rootPath, path.join(directory, 'sessions'));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

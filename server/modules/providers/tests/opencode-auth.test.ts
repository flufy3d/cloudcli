import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { OpenCodeProviderAuth } from '@/modules/providers/list/opencode/opencode-auth.provider.js';

/**
 * The credential check reads fixed paths under the user's home, so tests run
 * against a temp home. Environment API keys are cleared because they are the
 * last fallback and would otherwise mask a missing stored credential.
 */
const withOpenCodeAuthFixtures = async (
  runTest: (homeDir: string) => Promise<void>,
): Promise<void> => {
  const originalHomedir = os.homedir;
  const envKeys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
  ];
  const previousEnvValues = envKeys.map((key) => process.env[key]);

  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-auth-'));
  (os as any).homedir = () => homeDir;
  for (const [index, key] of envKeys.entries()) {
    delete process.env[key];
    void index;
  }

  try {
    await runTest(homeDir);
  } finally {
    (os as any).homedir = originalHomedir;
    envKeys.forEach((key, index) => {
      const previous = previousEnvValues[index];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
    await rm(homeDir, { recursive: true, force: true });
  }
};

/** Creates the v2 OpenCode SQLite database with its credential table. */
const createOpenCodeCredentialDatabase = async (
  homeDir: string,
  rows: Array<{ label: string; active: number }>,
): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE credential (
        id text PRIMARY KEY,
        integration_id text,
        label text NOT NULL,
        value text NOT NULL,
        connector_id text,
        method_id text,
        active integer,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
      VALUES (?, 'opencode', ?, 'secret', ?, ?, ?)
    `);
    rows.forEach((row, index) => {
      insert.run(`cred_${index}`, row.label, row.active, 1000 + index, 2000 + index);
    });
  } finally {
    db.close();
  }
};

test('getStatus reports authenticated from the v2 credential database when auth.json is absent', async () => {
  await withOpenCodeAuthFixtures(async () => {
    await createOpenCodeCredentialDatabase(os.homedir(), [
      { label: 'Personal', active: 0 },
      { label: 'Azrael', active: 1 },
    ]);

    const status = await new OpenCodeProviderAuth().getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'credentials_db');
    assert.equal(status.email, 'Azrael');
    assert.equal(status.error, undefined);
  });
});

test('getStatus treats a credential database without active rows as not configured', async () => {
  await withOpenCodeAuthFixtures(async () => {
    await createOpenCodeCredentialDatabase(os.homedir(), [
      { label: 'Personal', active: 0 },
    ]);

    const status = await new OpenCodeProviderAuth().getStatus();

    assert.equal(status.authenticated, false);
    assert.equal(status.error, 'OpenCode not configured');
  });
});

test('getStatus still reports authenticated from the legacy v1 auth.json', async () => {
  await withOpenCodeAuthFixtures(async (homeDir) => {
    const authPath = path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({ anthropic: { type: 'api_key', key: 'secret' } }),
      'utf8',
    );

    const status = await new OpenCodeProviderAuth().getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'credentials_file');
  });
});

test('getStatus reports not configured when no credential source exists', async () => {
  await withOpenCodeAuthFixtures(async () => {
    const status = await new OpenCodeProviderAuth().getStatus();

    assert.equal(status.authenticated, false);
    assert.equal(status.error, 'OpenCode not configured');
    assert.equal(status.method, null);
  });
});

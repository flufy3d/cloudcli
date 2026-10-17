import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

import { getPublicKey } from '../vapid-keys.service.js';

const require = createRequire(import.meta.url);
const webPush = require('web-push') as {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
};

test('VAPID key lookup reads the saved public key when the feature is used', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vapid-keys-service-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');
  await writeFile(databasePath, '');
  process.env.DATABASE_PATH = databasePath;
  closeConnection();

  try {
    await initializeDatabase();
    const expectedKeys = webPush.generateVAPIDKeys();
    getConnection().prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)')
      .run(expectedKeys.publicKey, expectedKeys.privateKey);

    assert.equal(getPublicKey(), expectedKeys.publicKey);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

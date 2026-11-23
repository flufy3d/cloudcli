import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type Request, type Response } from 'express';

import {
  authenticateTokenOrApiKey,
  generateToken,
} from '../auth.middleware.js';
import { apiKeysDb, closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';

test('authenticateTokenOrApiKey middleware supports both JWT and API Key', async () => {
  await initializeDatabase();
  try {
    const testUser = userDb.createUser('dual-auth-user', 'some-hash');
    const jwtToken = generateToken(testUser);
    const userIdNum = Number(testUser.id);
    const createdKey = apiKeysDb.createApiKey(userIdNum, 'ci-key');

    const app = express();
    app.get('/protected', authenticateTokenOrApiKey, (req: Request, res: Response) => {
      res.json({ ok: true, user: (req as unknown as Record<string, unknown>).user });
    });

    const server = app.listen(0);
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Without credentials -> 401
      const resNoAuth = await fetch(`${baseUrl}/protected`);
      assert.equal(resNoAuth.status, 401);

      // 2. With invalid X-API-Key -> 401
      const resBadKey = await fetch(`${baseUrl}/protected`, {
        headers: { 'X-API-Key': 'ck_invalid_key_12345' },
      });
      assert.equal(resBadKey.status, 401);

      // 3. With valid X-API-Key -> 200
      const resValidKey = await fetch(`${baseUrl}/protected`, {
        headers: { 'X-API-Key': createdKey.apiKey },
      });
      assert.equal(resValidKey.status, 200);
      const dataValidKey = (await resValidKey.json()) as { ok: boolean; user: { id: number } };
      assert.equal(dataValidKey.ok, true);
      assert.equal(dataValidKey.user.id, userIdNum);

      // 4. With valid API key in Authorization: Bearer ck_... -> 200
      const resBearerKey = await fetch(`${baseUrl}/protected`, {
        headers: { Authorization: `Bearer ${createdKey.apiKey}` },
      });
      assert.equal(resBearerKey.status, 200);

      // 5. With valid JWT in Authorization: Bearer <jwt> -> 200
      const resJwt = await fetch(`${baseUrl}/protected`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
      });
      assert.equal(resJwt.status, 200);
      const dataJwt = (await resJwt.json()) as { ok: boolean; user: { id: number } };
      assert.equal(dataJwt.ok, true);
      assert.equal(dataJwt.user.id, userIdNum);

      // 6. With invalid Bearer token -> 401
      const resBadBearer = await fetch(`${baseUrl}/protected`, {
        headers: { Authorization: 'Bearer totally_invalid_token' },
      });
      assert.equal(resBadBearer.status, 401);
    } finally {
      server.close();
      await once(server, 'close');
    }
  } finally {
    closeConnection();
  }
});

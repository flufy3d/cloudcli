/**
 * The session lifecycle against engines that keep working between rounds.
 *
 * A conversation that still has work in flight cannot be archived away: the
 * work would keep running against a session the user can no longer see. The
 * automatic archive skips those sessions instead of failing.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { sessionsAutoArchiveService } from '@/modules/providers/services/sessions-auto-archive.service.js';
import { connectedClients } from '@/modules/websocket/index.js';
import type { IProvider } from '@/shared/interfaces.js';

/** A runtime that reports work for the sessions it is told about. */
function runtimeWithWork(busySessions: string[]): IProvider['runtime'] {
  return {
    hasSessionWork: (sessionId: string) => busySessions.includes(sessionId),
    closeSessionAdmission: () => {},
    releaseSession: () => {},
  } as unknown as IProvider['runtime'];
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-lifecycle-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function withRuntime(
  runtime: IProvider['runtime'],
  runTest: () => void | Promise<void>,
): Promise<void> {
  const realListProviders = providerRegistry.listProviders;
  providerRegistry.listProviders = () => [{ id: 'codex', runtime } as IProvider];
  try {
    await runTest();
  } finally {
    providerRegistry.listProviders = realListProviders;
  }
}

test('a conversation with work in flight cannot be archived', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('busy-session', 'codex', '/workspace/demo', 'Busy session');
    await withRuntime(runtimeWithWork(['busy-session']), async () => {
      await assert.rejects(
        () => sessionsService.deleteOrArchiveSessionById('busy-session'),
        (error: { code?: string; statusCode?: number }) =>
          error.code === 'SESSION_HAS_ACTIVE_WORK' && error.statusCode === 409,
      );
    });
  });
});

test('an idle conversation is archived and its engine resources are released', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('idle-session', 'codex', '/workspace/demo', 'Idle session');
    const released: string[] = [];
    const runtime = {
      hasSessionWork: () => false,
      closeSessionAdmission: () => {},
      releaseSession: (sessionId: string) => released.push(sessionId),
    } as unknown as IProvider['runtime'];

    await withRuntime(runtime, async () => {
      const result = await sessionsService.deleteOrArchiveSessionById('idle-session');
      assert.equal(result.action, 'archived');
    });
    assert.ok(released.includes('idle-session'));
    assert.equal(sessionsDb.getSessionById('idle-session')?.isArchived, 1);
  });
});

test('the automatic archive skips the sessions that still have work', async () => {
  await withIsolatedDatabase(async () => {
    // Both conversations are older than the retention window; only one of
    // them still has work.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    sessionsDb.createSession('auto-idle-session', 'codex', '/workspace/demo', 'Idle session', twoDaysAgo, twoDaysAgo);
    sessionsDb.createSession('auto-busy-session', 'codex', '/workspace/demo', 'Busy session', twoDaysAgo, twoDaysAgo);

    await withRuntime(runtimeWithWork(['auto-busy-session']), async () => {
      const result = await sessionsAutoArchiveService.runAutoArchive(1);
      assert.equal(result.archivedCount, 1);
    });
    assert.equal(sessionsDb.getSessionById('auto-idle-session')?.isArchived, 1);
    assert.equal(sessionsDb.getSessionById('auto-busy-session')?.isArchived, 0);
  });
});

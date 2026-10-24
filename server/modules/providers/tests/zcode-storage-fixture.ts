import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Runs one test against an isolated ZCode storage tree: `ZCODE_STORAGE_DIR`
 * points at a fresh temp dir for the duration and is restored afterwards, so
 * the engine database, agent sidecars and config a test writes never touch
 * the developer's real `~/.zcode`.
 *
 * Consumers: the ZCode sessions and subagent tests.
 */
export async function withZCodeStorage(runTest: (storageDir: string) => Promise<void>): Promise<void> {
  const previous = process.env.ZCODE_STORAGE_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-sessions-'));
  process.env.ZCODE_STORAGE_DIR = tempDir;

  try {
    await runTest(tempDir);
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_STORAGE_DIR;
    } else {
      process.env.ZCODE_STORAGE_DIR = previous;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

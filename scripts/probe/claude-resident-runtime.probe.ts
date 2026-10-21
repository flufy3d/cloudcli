/**
 * Drives the Claude runtime (`queryClaudeSDK`, the production path, real CLI)
 * through three turns of one session with idle residency on and off, and
 * prints how long each turn took to its first reply. Runs in a throwaway
 * project directory; with `--transcript <file.jsonl>` it resumes a copy of
 * that transcript instead of starting a new session. Everything it creates is
 * removed at the end.
 *
 * Usage: npx tsx --tsconfig server/tsconfig.json scripts/probe/claude-resident-runtime.probe.ts [--transcript <file>]
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { closeClaudeResidentSessions, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

const transcriptArg = process.argv.indexOf('--transcript');
const sourceTranscript = transcriptArg > 0 ? process.argv[transcriptArg + 1] : null;

async function runSession(residentIdleMs: number): Promise<number[]> {
  process.env.CLOUDCLI_CLAUDE_RESIDENT_IDLE_MS = String(residentIdleMs);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resident-runtime-')));
  const projectDir = path.join(os.homedir(), '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  let nativeId: string | null = null;
  if (sourceTranscript) {
    nativeId = path.basename(sourceTranscript, '.jsonl');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.copyFileSync(sourceTranscript, path.join(projectDir, `${nativeId}.jsonl`));
  }
  const appSessionId = `probe-${randomUUID()}`;
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => nativeId,
    resolveTranscriptPath: () => (nativeId ? path.join(projectDir, `${nativeId}.jsonl`) : null),
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sid) => sessions.normalizeMessage(raw, sid),
    isProviderInstalled: async () => true,
  };
  const timings: number[] = [];
  try {
    for (let turn = 0; turn < 3; turn += 1) {
      const started = Date.now();
      let firstReply: number | null = null;
      let completed!: () => void;
      const complete = new Promise<void>((resolve) => { completed = resolve; });
      const writer = {
        userId: null,
        setSessionId: (id: string) => { nativeId ??= id; },
        send: (message: NormalizedMessage) => {
          if (message.kind === 'session_created' && typeof message.newSessionId === 'string') nativeId ??= message.newSessionId;
          if (message.kind === 'text' && firstReply === null) firstReply = Date.now() - started;
          if (message.kind === 'complete') completed();
        },
      };
      void queryClaudeSDK('只回复一个字：好', { sessionId: appSessionId, cwd, model: 'haiku', residentBetweenTurns: true }, writer as never, context);
      await complete;
      timings.push(firstReply ?? -1);
    }
  } finally {
    closeClaudeResidentSessions();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return timings;
}

console.log('residency off, ms to first reply per turn:', JSON.stringify(await runSession(0)));
console.log('residency on,  ms to first reply per turn:', JSON.stringify(await runSession(10 * 60 * 1000)));
process.exit(0);

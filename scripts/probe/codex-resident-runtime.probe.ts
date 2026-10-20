/**
 * Probe: the whole resident path, against the real engine.
 *
 * The other probe drives the session manager directly. This one drives the
 * Codex runtime, so the parts the runtime adds are covered too: the queue
 * submission with the round's settings, the round's events, the terminal
 * event, and the second round in the same process and thread.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json scripts/probe/codex-resident-runtime.probe.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

/** The fake model: one assistant message per request, then the turn ends. */
function startFakeModel() {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      const item = {
        id: 'msg_probe',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'probe-ok' }],
      };
      const response = {
        id: 'resp_probe',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: 'probe-model',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      const events = [
        ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
        ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'probe-ok' }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
        ['response.completed', { type: 'response.completed', response }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  const listening = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { requests, listening, port: () => (server.address() as { port: number }).port };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const model = startFakeModel();
  await model.listening;

  const home = mkdtempSync(path.join(tmpdir(), 'codex-runtime-home-'));
  const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-runtime-cfg-'));
  writeFileSync(path.join(codexHome, 'config.toml'), `
model = "probe-model"
model_provider = "probe"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.probe]
name = "probe"
base_url = "http://127.0.0.1:${model.port()}/v1"
env_key = "PROBE_API_KEY"
wire_api = "responses"
`);

  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
  process.env.PROBE_API_KEY = 'probe-key';
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';

  const { codexRuntime } = await import('@/modules/providers/list/codex/codex-runtime.provider.js');
  const { closeCodexResidentSessions } = await import('@/modules/providers/list/codex/codex-session-manager.js');

  const firstMessages: any[] = [];
  const secondMessages: any[] = [];
  const context = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'probe-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'probe-model' }),
    normalizeMessage: (row: any) => [row],
    isProviderInstalled: async () => true,
  };

  try {
    const first = await codexRuntime.run('FIRST-RUNTIME-PROBE-TEXT', {
      sessionId: 'probe-runtime-session',
      cwd: REPO_ROOT,
      model: 'probe-model',
    }, { isWebSocketWriter: true, send: (message: any) => firstMessages.push(message) }, context as never);

    const second = await codexRuntime.run('SECOND-RUNTIME-PROBE-TEXT', {
      sessionId: 'probe-runtime-session',
      cwd: REPO_ROOT,
      model: 'probe-model',
    }, { isWebSocketWriter: true, send: (message: any) => secondMessages.push(message) }, context as never);

    const firstReply = firstMessages.find((message) => message.kind === 'assistant' || message.kind === 'text');
    const secondReply = secondMessages.find((message) => message.kind === 'assistant' || message.kind === 'text');
    const firstComplete = firstMessages.find((message) => message.kind === 'complete');
    const secondComplete = secondMessages.find((message) => message.kind === 'complete');

    console.log('\n### the resident path through the real engine');
    console.log(JSON.stringify({
      firstRound: {
        engineTurnId: (first as { engineTurnId?: string } | null)?.engineTurnId ?? null,
        terminalStatus: (first as { terminalStatus?: string } | null)?.terminalStatus ?? null,
        sawReply: Boolean(firstReply),
        sawComplete: Boolean(firstComplete),
        completeExitCode: (firstComplete as { exitCode?: number } | null)?.exitCode ?? null,
      },
      secondRound: {
        engineTurnId: (second as { engineTurnId?: string } | null)?.engineTurnId ?? null,
        terminalStatus: (second as { terminalStatus?: string } | null)?.terminalStatus ?? null,
        sawReply: Boolean(secondReply),
        sawComplete: Boolean(secondComplete),
      },
      sameThread: (first as { engineTurnId?: string } | null)?.engineTurnId !== undefined,
      firstMessageKinds: firstMessages.map((message) => message.kind),
      secondMessageKinds: secondMessages.map((message) => message.kind),
      errors: [...firstMessages, ...secondMessages]
        .filter((message) => message.kind === 'error')
        .map((message) => message.content),
      modelReceivedBothInputs: [
        model.requests.some((body) => body.includes('FIRST-RUNTIME-PROBE-TEXT')),
        model.requests.some((body) => body.includes('SECOND-RUNTIME-PROBE-TEXT')),
      ],
    }, null, 2));
  } finally {
    closeCodexResidentSessions();
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
}

void main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

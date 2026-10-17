import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runTaskContinuationsMcp } from '@/modules/task-continuations/cli/task-continuations-mcp.js';

async function runProtocol(messages: unknown[], env: NodeJS.ProcessEnv = {}): Promise<unknown[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output: string[] = [];
  stdout.on('data', (chunk) => output.push(String(chunk)));
  const done = runTaskContinuationsMcp({ stdin, stdout, env });
  for (const message of messages) {
    stdin.write(`${JSON.stringify(message)}\n`);
  }
  stdin.end();
  await done;
  return output.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('stdio MCP advertises run, status, and notification cancellation tools', async () => {
  const responses = await runProtocol([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);

  assert.equal(responses.length, 2);
  assert.deepEqual((responses[1] as any).result.tools.map((tool: any) => tool.name), [
    'cloudcli_task_run',
    'cloudcli_task_status',
    'cloudcli_task_cancel_notification',
  ]);
  assert.equal((responses[1] as any).result.tools[0].annotations?.readOnlyHint, false);
  assert.equal((responses[1] as any).result.tools[0].annotations?.openWorldHint, undefined);
  assert.equal((responses[1] as any).result.tools[0].annotations?.destructiveHint, undefined);
  assert.equal((responses[1] as any).result.tools[1].annotations?.readOnlyHint, true);
});

test('tool calls fail closed when the host capability environment is absent', async () => {
  const responses = await runProtocol([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cloudcli_task_status', arguments: { taskId: 'task_1' } } },
  ]);

  assert.equal((responses[0] as any).result.isError, true);
  assert.match((responses[0] as any).result.content[0].text, /not available/i);
});

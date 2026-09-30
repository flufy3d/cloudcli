/**
 * OpenCode subagent approval routing tests.
 *
 * Subagent (task child) sessions raise their own `permission.asked` events on
 * the shared server event stream. The runtime filters every event by session
 * id, so before this routing existed a child's approval never became a card and
 * the subagent waited forever. These tests drive `handleOpenCodeApprovalEvent`
 * against a stub server that serves `GET /session/:id` parent chains, and pin
 * down that only sessions descending from the run's session are bridged.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  handleOpenCodeApprovalEvent,
  openCodePermissions,
  registerOpenCodeRun,
  unregisterOpenCodeRun,
} from '@/modules/providers/list/opencode/opencode-permissions.provider.js';
import type { OpenCodeBridgeRun } from '@/modules/providers/list/opencode/opencode-permissions.provider.js';
import type { OpenCodeServerEvent } from '@/modules/providers/list/opencode/opencode-server.client.js';

type StubReply = { method: string; path: string; body: Record<string, unknown> | null };

/** Parent chain the stub server exposes: child → run session, stranger elsewhere. */
const sessionParents: Record<string, string | null> = {
  ses_child: 'ses_parent',
  ses_grandchild: 'ses_child',
  ses_stranger: 'ses_other_parent',
  ses_orphan: null,
};

type StubServer = {
  baseUrl: string;
  replies: StubReply[];
  sessionReads: Map<string, number>;
  close: () => Promise<void>;
};

async function startStubServer(): Promise<StubServer> {
  const replies: StubReply[] = [];
  const sessionReads = new Map<string, number>();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname.startsWith('/session/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/session/'.length));
      sessionReads.set(sessionId, (sessionReads.get(sessionId) ?? 0) + 1);
      if (sessionId === 'ses_missing') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      const parentId = sessionParents[sessionId];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: sessionId, ...(parentId ? { parentID: parentId } : {}) }));
      return;
    }

    if (request.method === 'POST' && url.pathname.startsWith('/permission/')) {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        replies.push({
          method: request.method ?? 'POST',
          path: url.pathname,
          body: body ? (JSON.parse(body) as Record<string, unknown>) : null,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('true');
      });
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    replies,
    sessionReads,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

type TestRun = {
  run: OpenCodeBridgeRun;
  /** Live view of the writer's permission cards — never snapshot this. */
  cards: () => Array<Record<string, unknown>>;
  writerMessages: Array<Record<string, unknown>>;
};

function createRun(stub: StubServer, overrides: Partial<OpenCodeBridgeRun> = {}): TestRun {
  const writerMessages: Array<Record<string, unknown>> = [];
  const run = {
    runId: 'app-session-subagent',
    appSessionId: 'app-session-subagent',
    providerSessionId: 'ses_parent',
    directory: '/tmp/project',
    handle: { baseUrl: stub.baseUrl, headers: {} },
    writer: {
      send: (message: Record<string, unknown>) => {
        writerMessages.push(message);
      },
    },
    permissionMode: 'default',
    ...overrides,
  } as OpenCodeBridgeRun;

  registerOpenCodeRun(run);
  return {
    run,
    writerMessages,
    cards: () => writerMessages.filter((message) => message.kind === 'permission_request'),
  };
}

function permissionEvent(overrides: Record<string, unknown> = {}): OpenCodeServerEvent {
  return {
    type: 'permission.asked',
    directory: '/tmp/project',
    properties: {
      id: 'per_child_1',
      sessionID: 'ses_child',
      permission: 'external_directory',
      patterns: ['C:\\Users\\Example\\AppData\\Local\\Temp\\opencode\\*'],
      metadata: { filepath: 'C:\\Users\\Example\\AppData\\Local\\Temp\\opencode\\run.mjs' },
      tool: { messageID: 'msg_child_1', callID: 'call_child_1' },
      ...overrides,
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met in time');
}

test('an approval from the run\'s own session renders synchronously', async () => {
  const stub = await startStubServer();
  const testRun = createRun(stub, { runId: 'own-session-run' });

  try {
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_own_1', sessionID: 'ses_parent' }));

    assert.equal(testRun.cards().length, 1, 'the own-session card must be sent without waiting');
    assert.equal(testRun.cards()[0].requestId, 'per_own_1');
    assert.equal(stub.sessionReads.size, 0, 'the own session needs no parent lookup');
  } finally {
    unregisterOpenCodeRun(testRun.run.runId);
    await stub.close();
  }
});

test('a subagent permission ask bridges to the parent run and replies once', async () => {
  const stub = await startStubServer();
  const testRun = createRun(stub, { runId: 'child-session-run' });

  try {
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_child_reply' }));
    await waitFor(() => testRun.cards().length === 1);

    const card = testRun.cards()[0];
    assert.equal(card.requestId, 'per_child_reply');
    assert.deepEqual(card.input, {
      permission: 'external_directory',
      patterns: ['C:\\Users\\Example\\AppData\\Local\\Temp\\opencode\\*'],
      metadata: { filepath: 'C:\\Users\\Example\\AppData\\Local\\Temp\\opencode\\run.mjs' },
    });
    assert.equal(openCodePermissions.listPending('app-session-subagent').length, 1);

    openCodePermissions.resolve('per_child_reply', { allow: true });
    await waitFor(() => stub.replies.length === 1);

    assert.equal(stub.replies[0].path, '/permission/per_child_reply/reply');
    assert.deepEqual(stub.replies[0].body, { reply: 'once' });
    assert.equal(openCodePermissions.listPending('app-session-subagent').length, 0);
  } finally {
    unregisterOpenCodeRun(testRun.run.runId);
    await stub.close();
  }
});

test('a grandchild session still resolves to the run through the parent chain', async () => {
  const stub = await startStubServer();
  const testRun = createRun(stub, { runId: 'grandchild-session-run' });

  try {
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_grandchild_1', sessionID: 'ses_grandchild' }));
    await waitFor(() => testRun.cards().length === 1);

    assert.equal(testRun.cards()[0].requestId, 'per_grandchild_1');
    assert.equal(stub.sessionReads.get('ses_grandchild'), 1);
    assert.equal(stub.sessionReads.get('ses_child'), 1);
  } finally {
    unregisterOpenCodeRun(testRun.run.runId);
    await stub.close();
  }
});

test('sessions unrelated to the run are ignored', async () => {
  const stub = await startStubServer();
  const testRun = createRun(stub, { runId: 'unrelated-session-run' });

  try {
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_stranger', sessionID: 'ses_stranger' }));
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_orphan', sessionID: 'ses_orphan' }));
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_missing', sessionID: 'ses_missing' }));
    // The stranger's chain is walked to its end as well: stranger → its parent.
    await waitFor(() =>
      stub.sessionReads.has('ses_stranger')
      && stub.sessionReads.has('ses_other_parent')
      && stub.sessionReads.has('ses_orphan')
      && stub.sessionReads.has('ses_missing'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(testRun.cards().length, 0, 'foreign sessions must not render cards on this run');
    assert.equal(openCodePermissions.listPending('app-session-subagent').length, 0);
    assert.equal(stub.replies.length, 0);
  } finally {
    unregisterOpenCodeRun(testRun.run.runId);
    await stub.close();
  }
});

test('the parent-chain lookup is cached per session, including in-flight events', async () => {
  const stub = await startStubServer();
  const testRun = createRun(stub, { runId: 'cached-lookup-run' });

  try {
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_cached_1' }));
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_cached_2' }));
    await waitFor(() => testRun.cards().length === 2);

    assert.equal(stub.sessionReads.get('ses_child'), 1, 'simultaneous asks must share one lookup');
  } finally {
    unregisterOpenCodeRun(testRun.run.runId);
    await stub.close();
  }
});

test('bypassPermissions auto-approves a subagent ask without rendering a card', async () => {
  const stub = await startStubServer();
  const testRun = createRun(stub, {
    runId: 'bypass-subagent-run',
    permissionMode: 'bypassPermissions',
  });

  try {
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_bypass_child' }));
    await waitFor(() => stub.replies.length === 1);

    assert.equal(testRun.cards().length, 0);
    assert.deepEqual(stub.replies[0].body, { reply: 'once' });
  } finally {
    unregisterOpenCodeRun(testRun.run.runId);
    await stub.close();
  }
});

test('a subagent settle event retracts the card it announced', async () => {
  const stub = await startStubServer();
  const testRun = createRun(stub, { runId: 'settle-child-run' });

  try {
    handleOpenCodeApprovalEvent(testRun.run, permissionEvent({ id: 'per_settle_child' }));
    await waitFor(() => testRun.cards().length === 1);

    handleOpenCodeApprovalEvent(testRun.run, {
      type: 'permission.replied',
      directory: '/tmp/project',
      properties: { sessionID: 'ses_child', requestID: 'per_settle_child' },
    });
    await waitFor(() => openCodePermissions.listPending('app-session-subagent').length === 0);

    assert.ok(testRun.writerMessages.some((message) => message.kind === 'permission_cancelled'));
    assert.equal(stub.replies.length, 0, 'settling is not a user decision');
  } finally {
    unregisterOpenCodeRun(testRun.run.runId);
    await stub.close();
  }
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import {
  OpenCodeEventStream,
  splitSseFrames,
  type OpenCodeEventEnvelope,
} from '@/modules/providers/list/opencode/opencode-event-stream.js';

type FakeFeed = {
  url: string;
  connections: http.ServerResponse[];
  authHeaders: Array<string | undefined>;
  /** Resolves when the n-th connection (1-based) has been accepted. */
  waitForConnection: (count: number) => Promise<http.ServerResponse>;
  close: () => void;
  rejectNext: { status: number } | null;
};

/** A stand-in for `GET /api/event`: hands the test each live response so it can push frames or drop the socket. */
const startFakeFeed = async (): Promise<FakeFeed> => {
  const connections: http.ServerResponse[] = [];
  const authHeaders: Array<string | undefined> = [];
  const waiters: Array<{ count: number; resolve: (response: http.ServerResponse) => void }> = [];
  const feed: FakeFeed = {
    url: '',
    connections,
    authHeaders,
    rejectNext: null,
    waitForConnection: (count) => new Promise((resolve) => {
      if (connections.length >= count) {
        resolve(connections[count - 1]);
        return;
      }
      waiters.push({ count, resolve });
    }),
    close: () => {
      for (const connection of connections) {
        connection.destroy();
      }
      server.close();
    },
  };
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/event') {
      response.writeHead(404).end();
      return;
    }
    authHeaders.push(request.headers.authorization);
    if (feed.rejectNext) {
      response.writeHead(feed.rejectNext.status).end();
      feed.rejectNext = null;
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(': connected\n\n');
    connections.push(response);
    for (const waiter of [...waiters]) {
      if (connections.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(connections[waiter.count - 1]);
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  feed.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return feed;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('splitSseFrames returns complete frames and keeps the partial tail', () => {
  const { frames, rest } = splitSseFrames('data: {"a":1}\n\n: heartbeat\n\ndata: {"b"');
  assert.deepEqual(frames, ['data: {"a":1}', ': heartbeat']);
  assert.equal(rest, 'data: {"b"');
  assert.deepEqual(splitSseFrames('data: x\r\n\r\n'), { frames: ['data: x'], rest: '' });
});

test('delivers parsed events, skips heartbeats and non-JSON, and sends Basic auth', async () => {
  const feed = await startFakeFeed();
  const received: OpenCodeEventEnvelope[] = [];
  const stream = new OpenCodeEventStream(async () => ({ url: feed.url, authorization: 'Basic abc' }), { backoffBaseMs: 10 });
  stream.subscribe((event) => received.push(event));
  try {
    stream.start();
    const connection = await feed.waitForConnection(1);
    assert.equal(feed.authHeaders[0], 'Basic abc');
    connection.write('data: {"id":"evt_1","type":"server.connected","data":{}}\n\n');
    connection.write(': heartbeat\n\n');
    connection.write('data: not json\n\n');
    connection.write('data: {"type":"session.text.delta","data":{"sessionID":"ses_1","delta":"hi"}}\n\n');
    // A frame split across two chunks must still parse once completed.
    connection.write('data: {"type":"session.text.');
    await new Promise((resolve) => setTimeout(resolve, 20));
    connection.write('ended","data":{"sessionID":"ses_1","text":"hi"}}\n\n');
    await waitFor(() => received.length === 3);
    assert.deepEqual(received.map((event) => event.type), ['server.connected', 'session.text.delta', 'session.text.ended']);
    assert.equal(stream.state, 'open');
  } finally {
    stream.stop();
    feed.close();
  }
});

test('reconnects after the server drops the connection and reports the reconnect', async () => {
  const feed = await startFakeFeed();
  let reconnects = 0;
  const resolved: string[] = [];
  const stream = new OpenCodeEventStream(async () => {
    resolved.push('resolve');
    return { url: feed.url, authorization: 'Basic abc' };
  }, { backoffBaseMs: 10, backoffMaxMs: 20 });
  stream.onReconnect(() => { reconnects += 1; });
  const received: string[] = [];
  stream.subscribe((event) => received.push(event.type));
  try {
    stream.start();
    const first = await feed.waitForConnection(1);
    assert.equal(reconnects, 0);
    first.end();
    const second = await feed.waitForConnection(2);
    await waitFor(() => reconnects === 1);
    assert.equal(resolved.length, 2, 'the endpoint is re-resolved on every connect');
    second.write('data: {"type":"after.reconnect","data":{}}\n\n');
    await waitFor(() => received.includes('after.reconnect'));
  } finally {
    stream.stop();
    feed.close();
  }
});

test('treats a non-2xx response as a drop and keeps retrying with backoff', async () => {
  const feed = await startFakeFeed();
  feed.rejectNext = { status: 401 };
  const stream = new OpenCodeEventStream(async () => ({ url: feed.url, authorization: 'Basic abc' }), { backoffBaseMs: 10, backoffMaxMs: 20 });
  try {
    stream.start();
    await feed.waitForConnection(1);
    assert.equal(feed.authHeaders.length, 2, 'one rejected attempt, then a successful one');
  } finally {
    stream.stop();
    feed.close();
  }
});

test('retries when the endpoint cannot be resolved yet', async () => {
  const feed = await startFakeFeed();
  let attempts = 0;
  const stream = new OpenCodeEventStream(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('service booting');
    }
    return { url: feed.url, authorization: 'Basic abc' };
  }, { backoffBaseMs: 5, backoffMaxMs: 10 });
  try {
    stream.start();
    await feed.waitForConnection(1);
    assert.equal(attempts, 3);
  } finally {
    stream.stop();
    feed.close();
  }
});

test('stop aborts the live connection and prevents reconnects', async () => {
  const feed = await startFakeFeed();
  const stream = new OpenCodeEventStream(async () => ({ url: feed.url, authorization: 'Basic abc' }), { backoffBaseMs: 5 });
  try {
    stream.start();
    const connection = await feed.waitForConnection(1);
    stream.stop();
    await once(connection, 'close');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(feed.connections.length, 1);
    assert.equal(stream.state, 'stopped');
  } finally {
    feed.close();
  }
});

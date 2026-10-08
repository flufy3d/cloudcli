import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { configureHttpTimeouts } from './http-timeouts.js';

test('the HTTP server outlives common proxy idle pools by default', () => {
  const server = http.createServer();
  configureHttpTimeouts(server, {});
  assert.equal(server.keepAliveTimeout, 125_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
});

test('an explicit timeout is applied in milliseconds', () => {
  const server = http.createServer();
  configureHttpTimeouts(server, { HTTP_KEEP_ALIVE_TIMEOUT_MS: '180000' });
  assert.equal(server.keepAliveTimeout, 180_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
});

for (const value of ['', '0', '-1', 'Infinity', 'NaN', '125000junk', '1.5', '2147483647']) {
  test(`invalid timeout ${JSON.stringify(value)} fails startup rather than silently falling back`, () => {
    assert.throws(() => configureHttpTimeouts(http.createServer(), { HTTP_KEEP_ALIVE_TIMEOUT_MS: value }),
      /HTTP_KEEP_ALIVE_TIMEOUT_MS/);
  });
}

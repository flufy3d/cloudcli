import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  buildProxyResponseHeaders,
  createProxyTicket,
  hasValidProxySession,
  redeemProxyTicket,
  resolveForwardPort,
} from '@/modules/local-proxy/local-proxy.service.js';
import { AppError } from '@/shared/utils.js';

test('creates a proxy path that keeps the port, path and query of a loopback URL', () => {
  const { proxyPath } = createProxyTicket('http://localhost:4174/reports/architecture.html?tab=2');

  const parsed = new URL(proxyPath, 'http://cloudcli.test');
  assert.equal(parsed.pathname, '/api/local-proxy/p/4174/reports/architecture.html');
  assert.equal(parsed.searchParams.get('tab'), '2');
  assert.ok(parsed.searchParams.get('ticket'));
});

test('accepts every loopback spelling', () => {
  for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '[::1]']) {
    const { proxyPath } = createProxyTicket(`http://${host}:5000/index.html`);
    assert.match(proxyPath, /^\/api\/local-proxy\/p\/5000\/index\.html\?ticket=/);
  }
});

test('rejects targets that are not a plain http loopback service', () => {
  const rejected = [
    'http://example.com:4174/',
    'http://10.0.0.5:4174/',
    'https://localhost:4174/',
    'file:///etc/passwd',
    'not a url',
  ];

  for (const target of rejected) {
    assert.throws(() => createProxyTicket(target), AppError, target);
  }
});

test('rejects the server its own port so the proxy cannot loop back into itself', () => {
  const previousPort = process.env.SERVER_PORT;
  process.env.SERVER_PORT = '3030';

  try {
    assert.throws(() => createProxyTicket('http://localhost:3030/'), AppError);
    assert.throws(() => resolveForwardPort('3030'), AppError);
  } finally {
    if (previousPort === undefined) {
      delete process.env.SERVER_PORT;
    } else {
      process.env.SERVER_PORT = previousPort;
    }
  }
});

test('rejects ports outside the valid TCP range', () => {
  assert.throws(() => resolveForwardPort('0'), AppError);
  assert.throws(() => resolveForwardPort('65536'), AppError);
  assert.throws(() => resolveForwardPort('not-a-port'), AppError);
  assert.equal(resolveForwardPort('4174'), 4174);
});

test('a ticket opens exactly one session and cannot be replayed', () => {
  const { proxyPath } = createProxyTicket('http://localhost:4174/');
  const ticket = new URL(proxyPath, 'http://cloudcli.test').searchParams.get('ticket') ?? '';

  const session = redeemProxyTicket(ticket, 4174);
  assert.ok(session);
  assert.ok(session.maxAgeSeconds > 0);
  assert.equal(hasValidProxySession(session.sessionToken), true);

  assert.equal(redeemProxyTicket(ticket, 4174), null);
});

test('a ticket is only valid for the port it was issued for', () => {
  const { proxyPath } = createProxyTicket('http://localhost:4174/');
  const ticket = new URL(proxyPath, 'http://cloudcli.test').searchParams.get('ticket') ?? '';

  assert.equal(redeemProxyTicket(ticket, 9999), null);
});

test('an unissued session token is never accepted', () => {
  assert.equal(hasValidProxySession('made-up-token'), false);
  assert.equal(hasValidProxySession(undefined), false);
});

test('tickets and sessions expire', () => {
  mock.timers.enable({ apis: ['Date'] });

  try {
    const expiring = createProxyTicket('http://localhost:4174/');
    const expiringTicket = new URL(expiring.proxyPath, 'http://cloudcli.test').searchParams.get('ticket') ?? '';
    mock.timers.tick(61_000);
    assert.equal(redeemProxyTicket(expiringTicket, 4174), null);

    const fresh = createProxyTicket('http://localhost:4174/');
    const freshTicket = new URL(fresh.proxyPath, 'http://cloudcli.test').searchParams.get('ticket') ?? '';
    const session = redeemProxyTicket(freshTicket, 4174);
    assert.ok(session);
    mock.timers.tick(session.maxAgeSeconds * 1000 + 1_000);
    assert.equal(hasValidProxySession(session.sessionToken), false);
  } finally {
    mock.timers.reset();
  }
});

test('strips headers that would let a proxied page act on the cloudcli origin', () => {
  const headers = buildProxyResponseHeaders(
    {
      'content-type': 'text/html',
      'set-cookie': ['session=1'],
      'content-security-policy': "default-src 'none'",
      'content-security-policy-report-only': "default-src 'none'",
      'strict-transport-security': 'max-age=63072000',
    },
    200,
    4174,
  );

  assert.equal(headers['content-type'], 'text/html');
  assert.equal(headers['set-cookie'], undefined);
  assert.equal(headers['content-security-policy'], undefined);
  assert.equal(headers['content-security-policy-report-only'], undefined);
  assert.equal(headers['strict-transport-security'], undefined);
});

test('rewrites redirect targets back onto the proxy prefix', () => {
  const relative = buildProxyResponseHeaders({ location: '/login?next=/' }, 302, 4174);
  assert.equal(relative.location, '/api/local-proxy/p/4174/login?next=/');

  const sameService = buildProxyResponseHeaders({ location: 'http://localhost:4174/login' }, 302, 4174);
  assert.equal(sameService.location, '/api/local-proxy/p/4174/login');

  // Another loopback port stays proxied, just under its own prefix.
  const otherPort = buildProxyResponseHeaders({ location: 'http://127.0.0.1:9000/x' }, 302, 4174);
  assert.equal(otherPort.location, '/api/local-proxy/p/9000/x');

  // A public redirect is left alone; the browser can reach it directly.
  const external = buildProxyResponseHeaders({ location: 'https://example.com/' }, 302, 4174);
  assert.equal(external.location, 'https://example.com/');
});

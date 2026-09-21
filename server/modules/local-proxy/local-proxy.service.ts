import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

import { AppError } from '@/shared/utils.js';

import { isLocalMachineHost } from '../../../shared/networkHosts.js';

/**
 * Chat transcripts routinely contain links to services running next to the
 * server — a preview server on :4174, a dev server on :5173. A browser on
 * another machine cannot open those, so this module hands them out through the
 * cloudcli origin instead.
 *
 * Two credentials carry that: a single-use ticket, minted by an authenticated
 * API call and spent on the first document request, and a session cookie
 * handed back in exchange. The cookie is what lets the page's own subresource
 * requests through, since a browser attaches no Authorization header to them.
 * Both live in memory only, so a restart closes every proxy session.
 */

const TICKET_TTL_MS = 60_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PROXY_PATH_PREFIX = '/api/local-proxy/p';

/** The cookie the proxy routes read to recognize an already-authorized browser. */
export const LOCAL_PROXY_SESSION_COOKIE = 'cloudcli_local_proxy';

/** Expiry timestamps, keyed by the secret handed to the browser. */
const tickets = new Map<string, { port: number; expiresAt: number }>();
const sessions = new Map<string, number>();

function dropExpired(): void {
  const now = Date.now();
  for (const [token, ticket] of tickets) {
    if (ticket.expiresAt <= now) {
      tickets.delete(token);
    }
  }
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

// The port cloudcli itself listens on. Proxying it would let the proxy serve
// (and recurse into) the app's own routes.
function getSelfPort(): number {
  return Number.parseInt(process.env.SERVER_PORT || '3001', 10);
}

/**
 * Validates one `:port` path segment and returns it as a number.
 *
 * Used by the proxy routes on every forwarded request, and indirectly by ticket
 * creation, so that an out-of-range or self-referential port is rejected in one
 * place rather than at each call site.
 */
export function resolveForwardPort(rawPort: string): number {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('Not a valid TCP port.', { code: 'LOCAL_PROXY_INVALID_PORT', statusCode: 400 });
  }
  if (port === getSelfPort()) {
    throw new AppError('Refusing to proxy the cloudcli server itself.', {
      code: 'LOCAL_PROXY_INVALID_PORT',
      statusCode: 400,
    });
  }
  return port;
}

/**
 * Mints a single-use ticket for a loopback URL and returns the path the browser
 * should open.
 *
 * Used by the local-proxy routes to answer `POST /api/local-proxy/tickets`.
 * Throws an AppError when the target is anything other than a plain http
 * service on this machine.
 */
export function createProxyTicket(rawUrl: string): { proxyPath: string } {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new AppError('Not a valid URL.', { code: 'LOCAL_PROXY_INVALID_TARGET', statusCode: 400 });
  }

  if (target.protocol !== 'http:') {
    throw new AppError('Only plain http targets can be proxied.', {
      code: 'LOCAL_PROXY_INVALID_TARGET',
      statusCode: 400,
    });
  }
  if (!isLocalMachineHost(target.hostname)) {
    throw new AppError('Only services on this machine can be proxied.', {
      code: 'LOCAL_PROXY_INVALID_TARGET',
      statusCode: 400,
    });
  }

  const port = resolveForwardPort(target.port || '80');

  dropExpired();
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { port, expiresAt: Date.now() + TICKET_TTL_MS });

  const query = new URLSearchParams(target.search);
  query.set('ticket', ticket);
  return { proxyPath: `${PROXY_PATH_PREFIX}/${port}${target.pathname}?${query.toString()}` };
}

/**
 * Spends a ticket and opens the browser session that replaces it.
 *
 * Used by the proxy routes on the first document request. Returns null when the
 * ticket is unknown, already spent, expired, or was issued for another port.
 */
export function redeemProxyTicket(
  ticket: string,
  port: number,
): { sessionToken: string; maxAgeSeconds: number } | null {
  dropExpired();
  const issued = tickets.get(ticket);
  if (!issued || issued.port !== port) {
    return null;
  }
  tickets.delete(ticket);

  const sessionToken = randomBytes(24).toString('base64url');
  sessions.set(sessionToken, Date.now() + SESSION_TTL_MS);
  return { sessionToken, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
}

/**
 * Reports whether a cookie value belongs to a live proxy session.
 *
 * Used by the proxy routes to authorize every request that arrives without a
 * ticket — which is all of a proxied page's subresources.
 */
export function hasValidProxySession(sessionToken: string | undefined): boolean {
  if (!sessionToken) {
    return false;
  }
  dropExpired();
  return sessions.has(sessionToken);
}

/**
 * Rewrites one upstream response's headers for delivery on the cloudcli origin.
 *
 * Used by the proxy routes as the forwarder's response header transform. Two
 * jobs: drop headers that would let a proxied page act on the cloudcli origin
 * (its own cookies, its CSP, HSTS), and keep redirects inside the proxy so a
 * dev server's `Location` does not bounce the browser to an unreachable host.
 */
export function buildProxyResponseHeaders(
  headers: IncomingHttpHeaders,
  statusCode: number,
  port: number,
): OutgoingHttpHeaders {
  const {
    'set-cookie': _cookies,
    'content-security-policy': _csp,
    'content-security-policy-report-only': _cspReport,
    'strict-transport-security': _hsts,
    location,
    ...forwarded
  } = headers;

  const result: OutgoingHttpHeaders = { ...forwarded };
  if (location) {
    result.location = rewriteLocation(String(location), port);
  }
  // 304s carry no body; anything else was re-framed by the forwarder.
  if (statusCode === 304) {
    delete result['content-length'];
  }
  return result;
}

function rewriteLocation(location: string, port: number): string {
  if (location.startsWith('/')) {
    return `${PROXY_PATH_PREFIX}/${port}${location}`;
  }

  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return location;
  }

  if (target.protocol !== 'http:' || !isLocalMachineHost(target.hostname)) {
    return location;
  }

  const targetPort = Number(target.port || '80');
  if (targetPort === getSelfPort()) {
    return location;
  }
  return `${PROXY_PATH_PREFIX}/${targetPort}${target.pathname}${target.search}`;
}

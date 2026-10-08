import type http from 'node:http';

const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 125_000;
const HEADERS_TIMEOUT_MARGIN_MS = 1000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Used by the server entrypoint to keep origin connections alive longer than
 * the proxy's idle pool. Custom proxies may require a larger value in PM2 env.
 * Invalid configuration fails startup instead of silently using another value.
 */
export function configureHttpTimeouts(server: http.Server, env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
  const keepAliveTimeout = raw === undefined ? DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(keepAliveTimeout)
    || keepAliveTimeout <= 0 || keepAliveTimeout > MAX_TIMER_DELAY_MS - HEADERS_TIMEOUT_MARGIN_MS) {
    throw new Error('HTTP_KEEP_ALIVE_TIMEOUT_MS must be a positive integer within the Node timer range');
  }
  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout = keepAliveTimeout + HEADERS_TIMEOUT_MARGIN_MS;
}

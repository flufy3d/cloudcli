import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import {
  LOCAL_PROXY_SESSION_COOKIE,
  buildProxyResponseHeaders,
  createProxyTicket,
  hasValidProxySession,
  redeemProxyTicket,
  resolveForwardPort,
} from '@/modules/local-proxy/local-proxy.service.js';
import { AppError, createApiSuccessResponse, forwardToLoopbackService } from '@/shared/utils.js';

const PROXY_PATH_PREFIX = '/api/local-proxy/p';

// Request headers worth passing to the local service. Everything else — above
// all `cookie` and `authorization` — is dropped so a local service can never
// see the caller's cloudcli credentials.
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'accept-encoding',
  'range',
  'user-agent',
  'if-none-match',
  'if-modified-since',
] as const;

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

function wildcardPath(req: Request): string {
  return (req.params as Record<string, string>)['0'] ?? '';
}

// The upstream path, minus the single-use ticket that only concerns the proxy.
function buildUpstreamPath(req: Request): string {
  const query = new URLSearchParams(req.query as Record<string, string>);
  query.delete('ticket');
  const search = query.toString();
  return `/${wildcardPath(req)}${search ? `?${search}` : ''}`;
}

function buildForwardedHeaders(req: Request, port: number): Record<string, string> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * Creates the routes that expose services listening on this machine to a remote
 * browser: `POST /tickets` mints a single-use ticket, `GET|HEAD /p/:port/*`
 * spends it and forwards the request.
 *
 * Used by the server entrypoint, which injects the JWT middleware as
 * `authenticate` — only ticket creation runs behind it, because the forwarded
 * requests come from a browser that cannot set an Authorization header and
 * carry the proxy's own session cookie instead.
 */
export function createLocalProxyRouter(authenticate: RequestHandler): express.Router {
  const router = express.Router();

  router.post('/tickets', authenticate, (req: Request, res: Response) => {
    const url = (req.body as { url?: unknown } | undefined)?.url;
    if (typeof url !== 'string' || !url.trim()) {
      throw new AppError('A target url is required.', {
        code: 'LOCAL_PROXY_INVALID_TARGET',
        statusCode: 400,
      });
    }
    res.json(createApiSuccessResponse(createProxyTicket(url.trim())));
  });

  const forward = (req: Request, res: Response, next: NextFunction): void => {
    const port = resolveForwardPort(String(req.params.port ?? ''));
    const sessionToken = readCookie(req.headers.cookie, LOCAL_PROXY_SESSION_COOKIE);

    if (!hasValidProxySession(sessionToken)) {
      const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
      const session = ticket ? redeemProxyTicket(ticket, port) : null;
      if (!session) {
        res.status(401).json({
          success: false,
          error: { code: 'LOCAL_PROXY_UNAUTHORIZED', message: 'This proxy link is no longer valid.' },
        });
        return;
      }

      // Hand the browser a cookie and bounce it to the same URL without the
      // ticket, so the secret stops appearing in the address bar, history and
      // the Referer of every subresource the page loads.
      res.setHeader(
        'Set-Cookie',
        `${LOCAL_PROXY_SESSION_COOKIE}=${session.sessionToken}; Path=/api/local-proxy; Max-Age=${session.maxAgeSeconds}; HttpOnly; SameSite=Lax`,
      );
      res.redirect(302, `${PROXY_PATH_PREFIX}/${port}${buildUpstreamPath(req)}`);
      return;
    }

    forwardToLoopbackService(
      {
        port,
        path: buildUpstreamPath(req),
        method: req.method,
        headers: buildForwardedHeaders(req, port),
        transformResponseHeaders: (headers, statusCode) => buildProxyResponseHeaders(headers, statusCode, port),
      },
      res,
      next,
    );
  };

  router.get('/p/:port/*', forward);
  router.head('/p/:port/*', forward);
  router.all('/p/:port/*', (_req: Request, res: Response) => {
    res.status(405).json({
      success: false,
      error: { code: 'LOCAL_PROXY_METHOD_NOT_ALLOWED', message: 'The local proxy only serves GET and HEAD.' },
    });
  });

  return router;
}

/**
 * Sends root-absolute asset requests made by a proxied page back into that
 * page's proxy prefix.
 *
 * Used by the server entrypoint, mounted ahead of the static handlers: a page
 * served through the proxy still asks for `/assets/app.js` on the cloudcli
 * origin, where it would hit the SPA's own static files. The Referer names the
 * proxy prefix that page came from, which is enough to redirect the request to
 * the right local service.
 */
export const localProxyAbsolutePathFallback: RequestHandler = (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  const referer = req.headers.referer;
  if (!referer) {
    next();
    return;
  }

  let refererPath: string;
  try {
    refererPath = new URL(referer, 'http://cloudcli.invalid').pathname;
  } catch {
    next();
    return;
  }

  const proxied = /^\/api\/local-proxy\/p\/(\d+)\//.exec(refererPath);
  if (!proxied) {
    next();
    return;
  }

  res.redirect(302, `${PROXY_PATH_PREFIX}/${proxied[1]}${req.originalUrl}`);
};

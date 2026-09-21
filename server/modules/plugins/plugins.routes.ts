import fs from 'node:fs';

import express from 'express';

import { forwardToLoopbackService } from '@/shared/utils.js';

import type { createPluginsService } from './plugins.service.js';

function wildcardPath(req: express.Request): string {
  return ((req.params as Record<string, string>)['0'] ?? '').trim();
}

function routeParameter(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

/** Creates plugin routes; transport streaming remains here while decisions live in the service. */
export function createPluginsRouter(service: ReturnType<typeof createPluginsService>): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json(await operation(req)); } catch (error) { next(error); }
    };

  router.get('/', respond(() => service.list()));
  router.get('/:name/manifest', respond((req) => service.getManifest(routeParameter(req.params.name))));
  router.get('/:name/assets/*', async (req, res, next) => {
    try {
      const asset = service.resolveAsset(routeParameter(req.params.name), wildcardPath(req));
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      const stream = fs.createReadStream(asset.path);
      stream.on('error', next);
      stream.pipe(res);
    } catch (error) { next(error); }
  });
  router.put('/:name/enable', respond((req) => service.setEnabled(routeParameter(req.params.name), req.body?.enabled)));
  router.post('/install', respond((req) => service.install(req.body?.url)));
  router.post('/:name/update', respond((req) => service.update(routeParameter(req.params.name))));
  router.all('/:name/rpc/*', async (req, res, next) => {
    try {
      const { port, secrets } = await service.prepareRpc(routeParameter(req.params.name));
      const headers: Record<string, string> = {
        'content-type': String(req.headers['content-type'] ?? 'application/json'),
      };
      for (const [key, value] of Object.entries(secrets)) {
        headers[`x-plugin-secret-${key.toLowerCase()}`] = String(value);
      }
      const query = req.url.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '';
      const hasBody = Boolean(req.headers['content-length']) && req.body !== undefined;
      forwardToLoopbackService(
        {
          port,
          path: `/${wildcardPath(req)}${query}`,
          method: req.method,
          headers,
          body: hasBody ? JSON.stringify(req.body) : undefined,
        },
        res,
        next,
      );
    } catch (error) { next(error); }
  });
  router.delete('/:name', respond((req) => service.uninstall(routeParameter(req.params.name))));
  return router;
}

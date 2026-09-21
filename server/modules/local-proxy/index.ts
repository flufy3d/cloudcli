// createLocalProxyRouter: mounted by server/index.ts under /api/local-proxy, with the JWT middleware injected.
// localProxyAbsolutePathFallback: mounted by server/index.ts ahead of the static handlers so a proxied page's
// root-absolute asset requests land on the local service instead of the SPA.
export { createLocalProxyRouter, localProxyAbsolutePathFallback } from './local-proxy.routes.js';

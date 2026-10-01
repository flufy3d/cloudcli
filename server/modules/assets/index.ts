// Express router mounted at /api/assets by server/index.ts for uploading and
// serving chat attachments stored in the global ~/.cloudcli/assets folder.
export { default as assetsRoutes } from './assets.routes.js';
// Consumed by the zcode sessions provider to safely resolve the stored
// filenames referenced by persisted non-image attachment parts.
export { resolveAttachmentAssetFile } from './services/image-assets.service.js';

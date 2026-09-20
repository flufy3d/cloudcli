import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type ResolveBrowserPlaywrightOptions = {
  runtimeInstallDir: string;
  fallbackRequire?: (id: string) => any;
};

const moduleRequire = createRequire(import.meta.url);

/**
 * Resolves the Playwright module consumed by the Browser Use service.
 * The injectable require is used by module tests to reproduce pnpm's global
 * dependency lookup without depending on the developer machine's packages.
 */
export function resolveBrowserPlaywright({
  runtimeInstallDir,
  fallbackRequire = moduleRequire,
}: ResolveBrowserPlaywrightOptions): any | null {
  const managedManifestPath = path.join(runtimeInstallDir, 'node_modules', 'playwright', 'package.json');
  if (fs.existsSync(managedManifestPath)) {
    try {
      return createRequire(path.join(runtimeInstallDir, 'package.json'))('playwright');
    } catch {
      // A present but broken managed runtime must not be hidden by an unrelated
      // Playwright package visible through pnpm's global dependency tree.
      return null;
    }
  }

  try {
    return fallbackRequire('playwright');
  } catch {
    return null;
  }
}

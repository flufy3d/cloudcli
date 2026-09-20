import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveBrowserPlaywright } from '@/modules/browser-use/browser-use-playwright.js';

async function writePlaywrightFixture(root: string, source: string): Promise<void> {
  const packageDirectory = path.join(root, 'node_modules', 'playwright');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'playwright',
    version: '1.0.0',
    main: 'index.cjs',
  }));
  await writeFile(path.join(packageDirectory, 'index.cjs'), `module.exports = { source: ${JSON.stringify(source)} };\n`);
}

test('managed browser runtime wins over an unrelated Playwright visible to the deployed package', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'browser-use-playwright-'));
  const deployedPackageRoot = path.join(temporaryRoot, 'global-package');
  const runtimeInstallDir = path.join(temporaryRoot, 'managed-runtime');

  try {
    await writePlaywrightFixture(deployedPackageRoot, 'unrelated-global-package');
    await writePlaywrightFixture(runtimeInstallDir, 'managed-runtime');

    const fallbackRequire = createRequire(path.join(deployedPackageRoot, 'service.cjs'));
    const playwright = resolveBrowserPlaywright({ runtimeInstallDir, fallbackRequire });

    assert.equal(playwright?.source, 'managed-runtime');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('development Playwright is used only when the managed runtime is not installed', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'browser-use-playwright-missing-'));

  try {
    const fallbackPlaywright = { source: 'development-package' };
    const playwright = resolveBrowserPlaywright({
      runtimeInstallDir: path.join(temporaryRoot, 'missing-runtime'),
      fallbackRequire: () => fallbackPlaywright,
    });

    assert.equal(playwright, fallbackPlaywright);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('missing managed and development Playwright returns null', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'browser-use-playwright-missing-'));

  try {
    const playwright = resolveBrowserPlaywright({
      runtimeInstallDir: path.join(temporaryRoot, 'missing-runtime'),
      fallbackRequire: () => {
        throw new Error('module not found');
      },
    });

    assert.equal(playwright, null);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('broken managed runtime is not hidden by a development Playwright fallback', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'browser-use-playwright-broken-'));
  const runtimeInstallDir = path.join(temporaryRoot, 'managed-runtime');
  const managedPackageDirectory = path.join(runtimeInstallDir, 'node_modules', 'playwright');
  let usedFallback = false;

  try {
    await mkdir(managedPackageDirectory, { recursive: true });
    await writeFile(path.join(managedPackageDirectory, 'package.json'), JSON.stringify({
      name: 'playwright',
      version: '1.0.0',
      main: 'missing-entry.cjs',
    }));

    const playwright = resolveBrowserPlaywright({
      runtimeInstallDir,
      fallbackRequire: () => {
        usedFallback = true;
        return { source: 'unrelated-global-package' };
      },
    });

    assert.equal(playwright, null);
    assert.equal(usedFallback, false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

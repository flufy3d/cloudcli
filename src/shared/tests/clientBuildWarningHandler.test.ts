import { describe, expect, it, vi } from 'vitest';
import { loadConfigFromFile } from 'vite';

import type { RollupWarning } from '@/shared/rollupWarningFilter';

/**
 * Resolves the `onwarn` handler the client build actually uses, so a change
 * to `vite.config.js` that swallows more than intended fails here instead of
 * silently hiding build warnings.
 */
async function getBuildOnwarn() {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    'vite.config.js',
    process.cwd(),
  );
  const onwarn = loaded?.config.build?.rollupOptions?.onwarn;
  if (typeof onwarn !== 'function') {
    throw new Error('vite.config.js must define build.rollupOptions.onwarn as a function');
  }
  // Rollup's own warning type carries more fields than the filter inspects;
  // the filter only reads `code` and `id`.
  return onwarn as unknown as (
    warning: RollupWarning,
    defaultHandler: (warning: RollupWarning) => void,
  ) => void;
}

describe('client build warning handler', () => {
  it('drops the virtua annotation warning', async () => {
    const onwarn = await getBuildOnwarn();
    const defaultHandler = vi.fn();

    onwarn(
      { code: 'INVALID_ANNOTATION', id: '/repo/node_modules/virtua/lib/index.js' },
      defaultHandler,
    );

    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it('passes every other warning to the default handler', async () => {
    const onwarn = await getBuildOnwarn();
    const defaultHandler = vi.fn();
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/src/modules/chat/components/Broken.tsx',
    };

    onwarn(warning, defaultHandler);

    expect(defaultHandler).toHaveBeenCalledWith(warning);
  });

  it('passes the circular dependency warnings to the default handler so Vite can hide them', async () => {
    const onwarn = await getBuildOnwarn();
    const defaultHandler = vi.fn();
    const warning: RollupWarning = { code: 'CIRCULAR_DEPENDENCY' };

    onwarn(warning, defaultHandler);

    expect(defaultHandler).toHaveBeenCalledWith(warning);
  });
});

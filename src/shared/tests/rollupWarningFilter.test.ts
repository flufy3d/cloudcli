import { describe, expect, it, vi } from 'vitest';

import {
  reportRollupWarning,
  shouldSuppressRollupWarning,
  type RollupWarning,
} from '@/shared/rollupWarningFilter';

describe('Rollup warning filter', () => {
  it('suppresses INVALID_ANNOTATION coming from the virtua package', () => {
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/node_modules/virtua/lib/index.js',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(true);
  });

  it('suppresses the virtua warning for every path inside the package', () => {
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/node_modules/virtua/lib/core/index.js',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(true);
  });

  it('suppresses the virtua warning on a Windows checkout', () => {
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: 'C:\\repo\\node_modules\\virtua\\lib\\index.js',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(true);
  });

  it('suppresses the virtua warning in a pnpm store layout', () => {
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/node_modules/.pnpm/virtua@0.52.9/node_modules/virtua/lib/index.js',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(true);
  });

  it('keeps INVALID_ANNOTATION from other packages so real problems stay visible', () => {
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/src/modules/chat/components/Broken.tsx',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(false);
  });

  it('keeps INVALID_ANNOTATION from a different node_modules package', () => {
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/node_modules/some-other-pkg/lib/index.js',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(false);
  });

  it('keeps every other warning code untouched', () => {
    const warning: RollupWarning = {
      code: 'CIRCULAR_DEPENDENCY',
      id: '/repo/node_modules/virtua/lib/index.js',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(false);
  });

  it('keeps warnings that carry no module id', () => {
    expect(shouldSuppressRollupWarning({ code: 'INVALID_ANNOTATION' })).toBe(false);
  });

  it('does not match a package whose name merely ends with "virtua"', () => {
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/node_modules/not-virtua/lib/index.js',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(false);
  });

  it('does not match a package whose name merely starts with "virtua"', () => {
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/node_modules/virtua-extra/lib/index.js',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(false);
  });

  it('does not match a scoped package that is not virtua', () => {
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/node_modules/@scope/virtua/lib/index.js',
    };

    expect(shouldSuppressRollupWarning(warning)).toBe(false);
  });
});

describe('Rollup warning reporting', () => {
  it('does not hand a suppressed virtua warning to the default handler', () => {
    const defaultHandler = vi.fn();
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/node_modules/virtua/lib/index.js',
    };

    reportRollupWarning(warning, defaultHandler);

    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it('hands every other warning to the default handler', () => {
    const defaultHandler = vi.fn();
    const warning: RollupWarning = {
      code: 'INVALID_ANNOTATION',
      id: '/repo/src/modules/chat/components/Broken.tsx',
    };

    reportRollupWarning(warning, defaultHandler);

    expect(defaultHandler).toHaveBeenCalledWith(warning);
  });

  it('hands the circular dependency warnings to the default handler so Vite can hide them', () => {
    const defaultHandler = vi.fn();
    const warning: RollupWarning = { code: 'CIRCULAR_DEPENDENCY' };

    reportRollupWarning(warning, defaultHandler);

    expect(defaultHandler).toHaveBeenCalledWith(warning);
  });
});

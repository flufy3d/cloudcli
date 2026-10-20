import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { TextEncoder } from 'node:util';

// vitest's jsdom pool gives the test realm its own `Uint8Array`, so a
// `TextEncoder` from Node's realm returns bytes that fail
// `instanceof globalThis.Uint8Array`. esbuild asserts that invariant on
// startup and refuses to run when it fails, so any test that loads a
// build-time dependency (esbuild, via Vite) aborts with "your JavaScript
// environment is broken". Point the global at the realm the encoder produces.
if (!(new globalThis.TextEncoder().encode('') instanceof globalThis.Uint8Array)) {
  const nodeUint8Array = new TextEncoder().encode('').constructor;
  Object.defineProperty(globalThis, 'Uint8Array', {
    configurable: true,
    writable: true,
    value: nodeUint8Array,
  });
}

// Node >= 26 ships an inert global `localStorage` (undefined without
// --localstorage-file) and, under vitest's jsdom pool, it shadows the storage
// implementation. Install a tiny in-memory stand-in so storage-touching tests
// exercise real set/get/clear semantics.
if (typeof (globalThis as Record<string, unknown>).localStorage === 'undefined') {
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
    key: (index: number) => Array.from(backing.keys())[index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key);
    },
    setItem: (key: string, value: string) => {
      backing.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
}

// Auto-cleanup only self-registers when vitest globals are enabled, and they are
// not. Without this, a hook rendered in one test stays mounted — with its timers
// and effects live — for the rest of the file.
afterEach(cleanup);

// jsdom ships no `matchMedia`, and components that pick a layout from the
// viewport call it during render. Report the desktop breakpoint, which is the
// layout the sidebar row tests assert on.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

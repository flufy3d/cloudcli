import { defineConfig } from 'vitest/config';

// The worktree tool is pure Node: its tests spawn real git in temp repos and
// must not run under the client suite's jsdom environment or setup files.
// Run via `npm run test:worktree`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/worktree/**/*.test.ts'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './tests/globalSetup.ts',
    setupFiles: ['./tests/setup.ts'],
    // Integration tests share one database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  test: {
    // Loads .env.test (mode "test"). Real shell variables, e.g. in CI, take precedence.
    env: loadEnv(mode, process.cwd(), ''),
    include: ['tests/**/*.test.js'],
    fileParallelism: false, // test files share one database
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
}));
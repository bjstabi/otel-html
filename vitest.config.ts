import { globSync, readFileSync } from 'node:fs';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

/**
 * Timing-sensitive tests (budgets scaled by OTEL_HTML_PERF_FACTOR) carry `@perf` in their name. The default run skips
 * them; `OTEL_HTML_PERF_PASS=1` runs only them, one file at a time, so parallel test files (or the lint and typecheck
 * that `mise run check` runs alongside) do not steal their CPU. `mise run test:unit` and `check` run both passes.
 */
const PERF_TAG = '@perf';
const { OTEL_HTML_PERF_PASS } = process.env;
const perfPass = OTEL_HTML_PERF_PASS === '1';
const perfFiles = globSync('test/**/*.test.{ts,tsx}').filter((f) =>
  readFileSync(f, 'utf8').includes(PERF_TAG),
);
const config: ViteUserConfig = defineConfig({
  test: {
    passWithNoTests: true,
    testNamePattern: perfPass ? new RegExp(PERF_TAG) : new RegExp(`^(?!.*${PERF_TAG})`),
    fileParallelism: !perfPass,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: perfPass ? perfFiles : ['test/**/*.test.ts'],
          exclude: ['test/viewer/**', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'viewer',
          environment: 'jsdom',
          setupFiles: ['test/viewer/setup.ts'],
          include: perfPass
            ? perfFiles.filter((f) => f.startsWith('test/viewer/'))
            : ['test/viewer/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});

export default config;

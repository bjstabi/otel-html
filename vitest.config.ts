import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { tracingEnabled } from './test-support/otel/enabled.ts';

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
    // Vitest's own spans (`vitest.test_run`, `run.test`, ...), exported when an OTLP endpoint is set.
    experimental: {
      openTelemetry: {
        enabled: tracingEnabled(process.env),
        sdkPath: fileURLToPath(new URL('./test-support/otel/vitest-sdk.ts', import.meta.url)),
      },
    },
    testNamePattern: perfPass ? new RegExp(PERF_TAG) : new RegExp(`^(?!.*${PERF_TAG})`),
    fileParallelism: !perfPass,
    globalSetup: ['test-support/perf-global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Keep in step with the node run of the `coverage` task in mise.toml, whose flag replaces this list.
      exclude: ['src/model/gen/**', 'src/**/*.gen.ts', 'src/**/*.gen.terms.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
    },
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

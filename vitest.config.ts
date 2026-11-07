import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { tracingEnabled } from './test-support/otel/enabled.ts';
import { PERF_TAG, perfFiles } from './test-support/perf-files.ts';

/**
 * Timing-sensitive tests (budgets scaled by OTEL_HTML_PERF_FACTOR) carry `@perf` in their name. The default run skips
 * them; `OTEL_HTML_PERF_PASS=1` runs only them, one file at a time, so parallel test files (or the lint and typecheck
 * that `mise run check` runs alongside) do not steal their CPU. `mise run test:unit` and `check` run both passes. A perf
 * pass that selects no file fails, so a file filter under `OTEL_HTML_PERF_PASS=1` must name a file with an `@perf` test.
 */
const { OTEL_HTML_PERF_PASS } = process.env;
const perfPass = OTEL_HTML_PERF_PASS === '1';
const perf = perfFiles(globSync('test/**/*.test.{ts,tsx}'), (f) => readFileSync(f, 'utf8'));
const config: ViteUserConfig = defineConfig({
  test: {
    // The perf pass always has files; finding none means the selection broke (#114), not that there is nothing to run.
    passWithNoTests: !perfPass,
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
          setupFiles: ['test-support/legacy-chunks.ts'],
          include: perfPass ? perf.node : ['test/**/*.test.ts'],
          exclude: ['test/viewer/**', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'viewer',
          environment: 'jsdom',
          setupFiles: ['test/viewer/setup.ts'],
          include: perfPass ? perf.viewer : ['test/viewer/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});

export default config;

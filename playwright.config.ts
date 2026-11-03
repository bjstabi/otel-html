import { defineConfig, devices, type PlaywrightTestConfig, type Project } from '@playwright/test';

const { CI } = process.env;
const browsers = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
];

// Playwright workers inherit this process's environment, including any OTEL_EXPORTER_OTLP_* variables the developer's
// shell sets. The worker fixture in e2e/test.ts starts a NodeSDK per worker (test-support/otel/sdk.ts) that exports one
// span per test, and the viewer spans under it, to that inherited endpoint; a test that spawns `serve`/`run` must still
// unset them first.
const config: PlaywrightTestConfig = defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: true,
  reporter: 'list',
  fullyParallel: true,
  ...(CI ? { workers: 4 } : {}),
  // Per browser, `-file` runs every spec over file:// (Firefox and WebKit leave out scale.spec.ts, so they need no scale
  // reports). Chromium alone has `-http`, the specs tagged `HTTP` (e2e/test.ts) over HTTP, and `-perf-file`, the `@perf`
  // ones, which `test:e2e` runs alone with one worker: loading over HTTP does not depend on the browser, and Linux
  // Firefox and WebKit are too slow for a budget to say much. `kindOf` (e2e/test.ts) reads the last `-` segment, so
  // `perf-file` is `file`.
  projects: browsers.flatMap((b): Project[] =>
    b.name === 'chromium'
      ? [
          { name: `${b.name}-file`, use: b.device, grepInvert: /@perf/ },
          { name: `${b.name}-http`, use: b.device, grep: /@http/, grepInvert: /@perf/ },
          { name: `${b.name}-perf-file`, use: b.device, grep: /@perf/ },
        ]
      : [{ name: `${b.name}-file`, use: b.device, grepInvert: /@perf/, testIgnore: 'scale.spec.ts' }],
  ),
});

export default config;

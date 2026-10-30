import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const urls = ['file', 'http'] as const;
const browsers = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
];

// Playwright workers inherit this process's environment, including any OTEL_EXPORTER_OTLP_* variables.
// Nothing reads them today; a test that spawns `serve`/`run` or registers an SDK must unset them first.
const config: PlaywrightTestConfig = defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: true,
  reporter: 'list',
  projects: browsers.flatMap((b) =>
    urls.map((kind) => ({
      name: `${b.name}-${kind}`,
      use: b.device,
    })),
  ),
});

export default config;

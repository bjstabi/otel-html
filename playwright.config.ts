import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig, devices, type PlaywrightTestConfig, type Project } from '@playwright/test';
import { parseShard, shardOf, type Weights } from './test-support/shard.ts';

const { CI, OTEL_HTML_E2E_SHARD } = process.env;
const browsers = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
];

// The specs a browser leaves out of its `-file` project (and Chromium's `-http`).
const ignored: Record<string, string[]> = {
  chromium: [],
  firefox: ['scale.spec.ts', 'preview.spec.ts'],
  webkit: ['scale.spec.ts', 'preview.spec.ts'],
};

// `OTEL_HTML_E2E_SHARD=i/n` (set by `test:e2e --shard i/n`) limits a browser's main-pass projects to shard i of n of its
// spec files, split by the seconds recorded in test-support/shard-weights.json (test-support/shard.ts). A value that is
// not i/n makes the config throw.
function shardFiles(browser: string): string[] | undefined {
  if (OTEL_HTML_E2E_SHARD === undefined || OTEL_HTML_E2E_SHARD === '') return undefined;
  const { index, count } = parseShard(OTEL_HTML_E2E_SHARD);
  const weights = (
    JSON.parse(readFileSync(new URL('./test-support/shard-weights.json', import.meta.url), 'utf8')) as {
      e2e: Record<string, Weights>;
    }
  ).e2e[browser];
  const skip = ignored[browser] ?? [];
  const entries = readdirSync(new URL('./e2e/', import.meta.url), { recursive: true, encoding: 'utf8' }).map(
    (f) => f.replaceAll('\\', '/'),
  );
  // The split knows only `e2e/*.spec.ts`; a test file anywhere else Playwright would run would be in no shard.
  const stray = entries.filter(
    (f) =>
      /\.(spec|test)\.[cm]?[jt]sx?$/.test(f) &&
      !/^[^/]+\.spec\.ts$/.test(f) &&
      !/(^|\/)(\.|node_modules\/)/.test(f),
  );
  if (stray.length > 0)
    throw new Error(`OTEL_HTML_E2E_SHARD splits only e2e/*.spec.ts; move or rename ${stray.join(', ')}`);
  const specs = entries.filter((f) => /^[^/]+\.spec\.ts$/.test(f) && !skip.includes(f)).sort();
  return shardOf(specs, weights ?? {}, index, count);
}

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
  // reports). Chromium alone has `-http`, the specs tagged `HTTP` (e2e/test.ts) over HTTP, and the `@perf` ones, which
  // `test:e2e` runs alone with one worker: `-perf-file` for the file:// ones and `-perf-http` for the `@perf @http`
  // ones (the scale reports, site format). Loading over HTTP does not depend on the browser, and Linux Firefox and
  // WebKit are too slow for a budget to say much. `kindOf` (e2e/test.ts) reads the last `-` segment, so `perf-file`
  // is `file` and `perf-http` is `http`. With OTEL_HTML_E2E_SHARD set (see `shardFiles`) the `-file` and `-http` projects
  // of a browser run the same shard's spec files; the perf projects stay whole and are sharded by Playwright's own
  // `--shard`, by test count.
  projects: browsers.flatMap((b): Project[] => {
    const files = shardFiles(b.name);
    const testMatch = files ? { testMatch: files } : {};
    return b.name === 'chromium'
      ? [
          { name: `${b.name}-file`, use: b.device, grepInvert: /@perf/, ...testMatch },
          { name: `${b.name}-http`, use: b.device, grep: /@http/, grepInvert: /@perf/, ...testMatch },
          { name: `${b.name}-perf-file`, use: b.device, grep: /@perf/, grepInvert: /@http/ },
          // `@perf` and `@http` both, in either order (the tag list of a title).
          { name: `${b.name}-perf-http`, use: b.device, grep: /(?=.*@perf)(?=.*@http)/ },
        ]
      : [
          {
            name: `${b.name}-file`,
            use: b.device,
            grepInvert: /@perf/,
            testIgnore: ignored[b.name] ?? [],
            ...testMatch,
          },
        ];
  }),
});

export default config;

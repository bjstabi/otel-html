import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { openSession } from '../../src/writer/session.js';
import { scaleLogsRequest, TEST_SCALE_IDS } from '../../test-support/scale-logs.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf } from './helpers.js';

/** Spec §16: at most this many bytes of chunk files per log record. */
const MAX_BYTES_PER_LOG = 200;
/** Spec §16: writer peak RSS for a 1M-log run. */
const MAX_RSS_BYTES = 512 * 1024 * 1024;
const OUT = 'r';
const TOTAL_LOGS = 1_000_000;
const LOAD_FILES = 10;
const run = promisify(execFile);
const LOAD_ENV = 'OTEL_HTML_LOAD';

describe('log chunk size', () => {
  test(`20k realistic logs take at most ${MAX_BYTES_PER_LOG} bytes each on disk`, async () => {
    const count = 20_000;
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
    for (let first = 0; first < count; first += 5000)
      await s.add(otlp(scaleLogsRequest(first, 5000, TEST_SCALE_IDS)), 'l.json');
    await s.close();
    const chunks = manifestOf(w, OUT).chunks.filter((c) => c.signal === 'logs');
    const bytes = chunks.reduce((n, c) => n + c.bytes, 0);
    const perLog = bytes / count;
    process.stdout.write(`LOG SIZE ${perLog.toFixed(1)} bytes/log over ${chunks.length} chunks\n`);
    expect(perLog).toBeLessThanOrEqual(MAX_BYTES_PER_LOG);
  });

  // The real pipeline: 10 OTLP files of 100k logs converted by the built library in a child process, whose own
  // high-water resident set size (process.resourceUsage().maxRSS, kilobytes) is the figure. Input is read in pieces
  // and parsed one resource entry at a time (OtlpJsonStream); measured about 300-320 MB on an Apple M-series Mac.
  // Run with OTEL_HTML_LOAD=1 after `mise run build`.
  test.skipIf(process.env[LOAD_ENV] !== '1')(
    'converting 1M logs from 10 files keeps peak RSS under 512 MB',
    { timeout: 900_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oh-load-'));
      try {
        const per = TOTAL_LOGS / LOAD_FILES;
        const files: string[] = [];
        for (let f = 0; f < LOAD_FILES; f++) {
          const file = join(dir, `logs-${f}.json`);
          await writeFile(file, JSON.stringify(scaleLogsRequest(f * per, per, TEST_SCALE_IDS)));
          files.push(file);
        }
        const lib = pathToFileURL(fileURLToPath(new URL('../../dist/index.js', import.meta.url))).href;
        const script = `import { convert } from ${JSON.stringify(lib)};
await convert({ input: ${JSON.stringify(files)}, out: ${JSON.stringify(join(dir, 'report'))} });
process.stdout.write(String(process.resourceUsage().maxRSS));`;
        const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
          maxBuffer: 1024 * 1024,
        });
        const peakBytes = Number(stdout.trim()) * 1024;
        process.stdout.write(
          `LOG RSS peak ${(peakBytes / 1048576).toFixed(0)} MB converting ${TOTAL_LOGS} logs\n`,
        );
        expect(peakBytes).toBeGreaterThan(0);
        expect(peakBytes).toBeLessThan(MAX_RSS_BYTES);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

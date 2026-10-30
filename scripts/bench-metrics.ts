import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Report } from '../src/api/index.js';
import { scaleMetrics } from '../test-support/scale-metrics.js';

/**
 * The metrics writer benchmark behind #35 and #40: the 1/30 slice of the metrics scale workload (200 metrics ×
 * 1,000 series × 12 collections, 2.4M points) fed to `Report.addMetrics` as protobuf messages, with a flush every
 * 6 collections as the e2e scale report does. Prints the ingest and `close` times and a hash over every file of the
 * report, so a change can show it is faster and that its output is byte for byte the same (or deliberately not).
 *
 *   bun scripts/bench-metrics.ts [--runs N] [--keep]
 *
 * Under bun, like the figures in #35; Node works too (`node --import tsx` or the built library). `--runs` repeats
 * the whole write and reports the median; `--keep` leaves the last report in place and prints its folder.
 */
const METRICS = 200;
const SERIES = 1_000;
const COLLECTIONS = 12;
const FLUSH_EVERY = 6;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}
const runs = Math.max(1, Number(arg('--runs') ?? 1));
const keep = process.argv.includes('--keep');

async function hashReport(dir: string): Promise<string> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
  const all = createHash('sha256');
  for (const file of files) {
    const rel = relative(dir, file);
    // `manifest.js` holds the write time; everything else is a pure function of the input.
    if (rel === 'data/manifest.js') continue;
    all.update(rel);
    all.update(
      createHash('sha256')
        .update(await readFile(file))
        .digest(),
    );
  }
  return `${all.digest('hex').slice(0, 16)} over ${files.length} files`;
}

async function once(): Promise<{ ingestMs: number; closeMs: number; hash: string; out: string }> {
  const out = await mkdtemp(join(tmpdir(), 'otel-html-bench-'));
  const report = await Report.create({ out, title: 'metrics bench' });
  const t0 = performance.now();
  for (let i = 0; i < COLLECTIONS; i++) {
    for (const request of scaleMetrics(METRICS, SERIES, 1, i)) await report.addMetrics(request);
    if ((i + 1) % FLUSH_EVERY === 0) await report.flush();
  }
  const t1 = performance.now();
  await report.close();
  const t2 = performance.now();
  return { ingestMs: t1 - t0, closeMs: t2 - t1, hash: await hashReport(out), out };
}

const versions: { bun?: string; node: string } = process.versions;
const runtime = versions.bun === undefined ? `node ${versions.node}` : `bun ${versions.bun}`;

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const results: Awaited<ReturnType<typeof once>>[] = [];
for (let r = 0; r < runs; r++) {
  const res = await once();
  results.push(res);
  process.stdout.write(
    `run ${r + 1}/${runs}: ingest ${(res.ingestMs / 1000).toFixed(2)} s, close ${(res.closeMs / 1000).toFixed(2)} s, total ${((res.ingestMs + res.closeMs) / 1000).toFixed(2)} s, hash ${res.hash}\n`,
  );
  if (!(keep && r === runs - 1)) await rm(res.out, { recursive: true, force: true });
}
const points = METRICS * SERIES * COLLECTIONS;
const total = median(results.map((r) => r.ingestMs + r.closeMs));
process.stdout.write(
  `median of ${runs}: ingest ${(median(results.map((r) => r.ingestMs)) / 1000).toFixed(2)} s, close ${(median(results.map((r) => r.closeMs)) / 1000).toFixed(2)} s, total ${(total / 1000).toFixed(2)} s (${(points / 1e6).toFixed(1)}M points, ${Math.round(points / (total / 1000) / 1000)}k points/s) on ${runtime}\n`,
);
if (new Set(results.map((r) => r.hash)).size > 1) {
  process.stderr.write('the runs wrote different reports: the writer is not deterministic\n');
  process.exitCode = 1;
}
if (keep) process.stdout.write(`report kept at ${results.at(-1)?.out}\n`);

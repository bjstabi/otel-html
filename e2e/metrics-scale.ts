import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Report } from '../src/api/index.js';
import { scaleMetrics } from '../test-support/scale-metrics.js';
import { METRICS_SCALE_DIR, SCALE_METRIC_POINTS, SCALE_METRIC_SERIES, SCALE_METRICS } from './fixture.js';

const SRC = new URL('../src/', import.meta.url);
const VIEWER_BUILD = new URL('../dist/viewer/assets/', import.meta.url);
const GENERATOR = new URL('../test-support/scale-metrics.ts', import.meta.url);
const KEY_FILE = new URL('./.cache/metrics-scale.key', import.meta.url);
/** Collections written between two flushes, so the writer spills its buckets to segments as a long run does. */
const FLUSH_EVERY = 6;

/**
 * What the report depends on: the library sources (the writer; `src/viewer` excluded), the generator and its size. A
 * reused report gets the current viewer build copied in instead (`refreshViewer`).
 */
async function cacheKey(): Promise<string> {
  const h = createHash('sha256');
  const sources = (await readdir(SRC, { recursive: true }))
    .filter((f) => /\.tsx?$/.test(f) && !f.startsWith(`viewer${sep}`))
    .sort();
  for (const f of sources) h.update(f).update(await readFile(new URL(f.split(sep).join('/'), SRC)));
  h.update(await readFile(GENERATOR));
  h.update(JSON.stringify([SCALE_METRICS, SCALE_METRIC_SERIES, SCALE_METRIC_POINTS]));
  return h.digest('hex');
}

/** Puts the current viewer build into a reused report: its assets, and the two references to them in index.html. */
async function refreshViewer(dir: URL): Promise<void> {
  const assets = new URL('assets/', dir);
  await rm(assets, { recursive: true, force: true });
  await cp(VIEWER_BUILD, assets, { recursive: true });
  const files = await readdir(VIEWER_BUILD);
  const js = files.find((f) => /^viewer\..+\.js$/.test(f));
  const css = files.find((f) => /^viewer\..+\.css$/.test(f));
  if (js === undefined || css === undefined)
    throw new Error(`no viewer build in ${fileURLToPath(VIEWER_BUILD)}`);
  const index = new URL('index.html', dir);
  const html = (await readFile(index, 'utf8'))
    .replace(/assets\/viewer\.[^"]+\.js/, `assets/${js}`)
    .replace(/assets\/viewer\.[^"]+\.css/, `assets/${css}`);
  await writeFile(index, html);
}

/**
 * The metrics scale report (`SCALE_METRICS` × `SCALE_METRIC_SERIES` × `SCALE_METRIC_POINTS` at 10 s), written through
 * the library API. Writing it takes about 15 minutes and ~12 GB of disk, so it is built only by the specs that need
 * it and kept between runs, outside `e2e/.reports/`, until the library or the generator changes.
 */
export async function ensureMetricsScaleReport(): Promise<void> {
  const key = await cacheKey();
  const have = await readFile(KEY_FILE, 'utf8').catch(() => null);
  if (have === key) {
    await refreshViewer(METRICS_SCALE_DIR);
    return;
  }
  const started = Date.now();
  // Written aside and moved into place, so an interrupted run never leaves a half report behind the key.
  const tmp = new URL(`./.cache/metrics-scale.tmp-${process.pid}/`, import.meta.url);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const report = await Report.create({ out: fileURLToPath(tmp), title: 'metrics scale run' });
  for (let i = 0; i < SCALE_METRIC_POINTS; i++) {
    for (const request of scaleMetrics(SCALE_METRICS, SCALE_METRIC_SERIES, 1, i))
      await report.addMetrics(request);
    if ((i + 1) % FLUSH_EVERY === 0) await report.flush();
  }
  await report.close();
  await rm(KEY_FILE, { force: true });
  await rm(METRICS_SCALE_DIR, { recursive: true, force: true });
  await rename(tmp, METRICS_SCALE_DIR);
  await writeFile(KEY_FILE, key);
  process.stdout.write(
    `metrics scale report written in ${((Date.now() - started) / 1000).toFixed(0)} s (kept for later runs)\n`,
  );
}

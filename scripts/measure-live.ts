// Measures the CI dashboard and the other pages on a local rebuild of the live site's data, served with a per-request
// delay (a model of network latency), cold, three runs per page.
//   bun scripts/measure-live.ts --out <dir> [--build <dist dir>] [--job <name>] [--from <dir>] [--no-rebuild]
// Downloads the live report into <out>/live (or copies --from <dir> there; the source is never changed), merges it into
// <out>/rebuilt with the build's CLI (the copy computes the indexes), prints the widget_traces share of the spans bytes,
// serves <out>/rebuilt with a 14 ms delay and measures each page. `mise run measure:live`.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { serve } from '../e2e/static-server.js';
import { unwrapDataFile } from '../src/format/data-file.js';
import { MANIFEST_KEY } from '../src/format/paths.js';

const LIVE = 'https://bjstabi.github.io/otel-html/branch/main/';
const DELAY_MS = 14;
const RUNS = 3;
const QUIET_MS = 2000;
const TIMEOUT_MS = 120_000;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const print = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};
const out = flag('--out');
if (out === undefined)
  throw new Error(
    'usage: measure-live.ts --out <dir> [--build <dist>] [--job <name>] [--from <dir>] [--no-rebuild]',
  );
const root = resolve(out);
const build = resolve(flag('--build') ?? 'dist');
const job = flag('--job') ?? 'check';
const live = join(root, 'live');
const rebuilt = join(root, 'rebuilt');

interface ManifestFile {
  path: string;
  bytes: number;
}
interface Manifest {
  formatVersion: number;
  partitions: { files: Record<string, ManifestFile> }[];
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function readManifest(dir: string): Promise<Manifest> {
  return unwrapDataFile(await readFile(join(dir, 'data/manifest.js'), 'utf8'), MANIFEST_KEY) as Manifest;
}

async function download(): Promise<void> {
  await mkdir(join(live, 'data'), { recursive: true });
  const get = async (rel: string): Promise<Buffer> => {
    const res = await fetch(new URL(rel, LIVE));
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  await writeFile(join(live, 'data/manifest.js'), await get('data/manifest.js'));
  const manifest = await readManifest(live);
  const wanted = manifest.partitions.flatMap((p) => Object.values(p.files));
  let done = 0;
  const queue = [...wanted];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
        const target = join(live, f.path);
        if ((await sizeOf(target)) !== f.bytes) {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await get(f.path));
        }
        done += 1;
      }
    }),
  );
  print(`downloaded ${done} files`);
}

function rebuild(): void {
  const cli = join(build, 'cli/main.js');
  const r = spawnSync(
    'node',
    [cli, 'merge', live, '-o', rebuilt, '--format', 'site', '--config', '.github/otel-html-ci.yaml'],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`merge exited ${r.status}`);
}

async function reportSize(): Promise<string> {
  const m = await readManifest(rebuilt);
  const sum = (kind: string): number => m.partitions.reduce((a, p) => a + (p.files[kind]?.bytes ?? 0), 0);
  const w = sum('widget_traces');
  const s = sum('spans');
  return `format ${m.formatVersion}: widget_traces ${w} bytes, spans ${s} bytes, ${s === 0 ? 0 : ((100 * w) / s).toFixed(3)} %`;
}

interface Sample {
  requests: number;
  spans: number;
  settledMs: number;
}

async function measure(base: string, route: string): Promise<{ sample: Sample; hash: string }> {
  const prefix = base.slice(0, base.lastIndexOf('/') + 1);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    let requests = 0;
    let spans = 0;
    let lastResponse = 0;
    let t0 = 0;
    ctx.on('request', (r) => {
      if (!r.url().startsWith(prefix)) return;
      requests += 1;
      if (r.url().includes('spans.parquet')) spans += 1;
    });
    ctx.on('response', (r) => {
      if (r.url().startsWith(prefix)) lastResponse = performance.now() - t0;
    });
    t0 = performance.now();
    await page.goto(base + route);
    // Settled: the last response before QUIET_MS with none.
    while (performance.now() - t0 - lastResponse < QUIET_MS && performance.now() - t0 < TIMEOUT_MS) {
      await new Promise((ok) => setTimeout(ok, 100));
    }
    return {
      sample: { requests, spans, settledMs: Math.round(lastResponse) },
      hash: await page.evaluate(() => location.hash),
    };
  } finally {
    await browser.close();
  }
}

/** The route of the first trace of the traces list: opens the list, clicks its first row and reads the route (`&trace=<id>`). */
async function firstTraceRoute(base: string): Promise<string> {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${base}#/traces?mode=traces`);
    await page.locator('select:has(option[value=list])').first().selectOption('list');
    const row = page.locator('div.cursor-pointer.absolute').first();
    await row.waitFor({ timeout: 60_000 });
    await row.click();
    await page.waitForFunction(() => location.hash.includes('trace='), undefined, { timeout: 30_000 });
    return await page.evaluate(() => location.hash);
  } finally {
    await browser.close();
  }
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const span = (xs: number[]): string => `${Math.min(...xs)}-${Math.max(...xs)}`;

async function main(): Promise<void> {
  const from = flag('--from');
  if (!args.includes('--no-rebuild') || (await sizeOf(join(live, 'data/manifest.js'))) === null) {
    if (from !== undefined) {
      await rm(live, { recursive: true, force: true });
      await cp(resolve(from), live, { recursive: true });
    } else await download();
  }
  if (!args.includes('--no-rebuild')) {
    await rm(rebuilt, { recursive: true, force: true });
    rebuild();
  }
  const dir = args.includes('--no-rebuild') ? live : rebuilt;
  print(await reportSize().catch(() => 'report size: unavailable'));
  const server = await serve([{ prefix: '/r', root: dir }], { delayMs: DELAY_MS });
  try {
    const base = `http://127.0.0.1:${server.port}/r/index.html`;
    const vars = encodeURIComponent(JSON.stringify({ vars: { 'cicd.pipeline.task.name': job } }));
    const trace = await firstTraceRoute(base);
    const pages: [string, string][] = [
      ['root', '#/'],
      ['ci', '#/dashboards/ci'],
      [`ci job=${job}`, `#/dashboards/ci?d=${vars}`],
      ['traces list', '#/traces?mode=traces'],
      ['logs', '#/logs'],
      [`trace open`, trace],
    ];
    print(`| page | requests | spans.parquet | settled ms |`);
    print(`| --- | --- | --- | --- |`);
    for (const [name, route] of pages) {
      const samples: Sample[] = [];
      for (let i = 0; i < RUNS; i += 1) samples.push((await measure(base, route)).sample);
      const col = (k: keyof Sample): number[] => samples.map((s) => s[k]);
      print(
        `| ${name} | ${median(col('requests'))} (${span(col('requests'))}) | ${median(col('spans'))} (${span(col('spans'))}) | ${median(col('settledMs'))} (${span(col('settledMs'))}) |`,
      );
    }
  } finally {
    await server.close();
  }
}

await main();

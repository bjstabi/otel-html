// Measures the CI dashboard and the other pages on a local rebuild of the live site's data, served with a per-request
// delay (a model of network latency), cold, three runs per page.
//   bun scripts/measure-live.ts --out <dir> [--build <dist dir>] [--job <name>] [--from <dir>] [--no-rebuild]
// Downloads the live report into <out>/live (or copies --from <dir> there; the source is never changed), merges it into
// <out>/rebuilt with the build's CLI (the copy computes the indexes), prints the widget_traces and cicd shares of the spans bytes,
// serves <out>/rebuilt with a 14 ms delay, measures each page and the slider's frame rate. `mise run measure:live`.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { chromium, type Page, type Request } from '@playwright/test';
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
  partitions: { cicd?: true; files: Record<string, ManifestFile> }[];
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

async function reportSize(dir: string): Promise<string> {
  const m = await readManifest(dir);
  const sum = (kind: string): number => m.partitions.reduce((a, p) => a + (p.files[kind]?.bytes ?? 0), 0);
  const w = sum('widget_traces');
  const s = sum('spans');
  const c = sum('cicd');
  const flagged = m.partitions.filter((p) => p.cicd === true).length;
  if (flagged === 0) throw new Error('no partition carries cicd: true: the merge derived no cicd table');
  const share = (n: number): string => (s === 0 ? '0' : ((100 * n) / s).toFixed(3));
  return [
    `format ${m.formatVersion}: widget_traces ${w} bytes, spans ${s} bytes, ${share(w)} %`,
    `cicd ${c} bytes, spans ${s} bytes, ${share(c)} %; ${flagged} of ${m.partitions.length} partitions carry cicd: true`,
  ].join('\n');
}

interface Sample {
  requests: number;
  spans: number;
  settledMs: number;
}

async function measure(
  base: string,
  route: string,
  after?: (page: Page) => Promise<void>,
): Promise<{ sample: Sample; hash: string }> {
  const prefix = base.slice(0, base.lastIndexOf('/') + 1);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    let requests = 0;
    let spans = 0;
    let lastDone = 0;
    let t0 = 0;
    // A `response` event comes when the headers do, so a request is open until `requestfinished` (the body is in) or `requestfailed`.
    const open = new Set<Request>();
    const done = (r: Request): void => {
      if (open.delete(r)) lastDone = performance.now() - t0;
    };
    ctx.on('request', (r) => {
      if (!r.url().startsWith(prefix)) return;
      requests += 1;
      open.add(r);
      if (r.url().includes('spans.parquet')) spans += 1;
    });
    ctx.on('requestfinished', done);
    ctx.on('requestfailed', done);
    t0 = performance.now();
    await page.goto(base + route);
    // Settled: no request open, and none opened or finished for QUIET_MS. The deadline is a failed sample, not a result.
    for (;;) {
      const now = performance.now() - t0;
      if (open.size === 0 && now - lastDone >= QUIET_MS) break;
      if (now >= TIMEOUT_MS)
        throw new Error(`${route}: not settled after ${TIMEOUT_MS} ms (${open.size} requests open)`);
      await new Promise((ok) => setTimeout(ok, 100));
    }
    const sample = { requests, spans, settledMs: Math.round(lastDone) };
    await after?.(page);
    return {
      sample,
      hash: await page.evaluate(() => location.hash),
    };
  } finally {
    await browser.close();
  }
}

const DRAG_MS = 2000;
const DRAG_STEP_MS = 16;

/** Frames per second over a 2 s scripted drag of the zoom slider's right handle toward the middle and back. */
async function dragFps(page: Page): Promise<number> {
  const handle = page.getByRole('slider', { name: 'Zoom end' });
  const track = await page.getByTestId('range-slider').boundingBox();
  const box = await handle.boundingBox();
  if (track === null || box === null) throw new Error('the zoom slider is not on the page');
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width / 2;
  const x1 = track.x + track.width / 2;
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __stop: boolean };
    w.__frames = 0;
    w.__stop = false;
    const tick = (): void => {
      w.__frames += 1;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const steps = Math.round(DRAG_MS / DRAG_STEP_MS);
  const t0 = performance.now();
  for (let i = 1; i <= steps; i += 1) {
    const f = i <= steps / 2 ? i / (steps / 2) : (steps - i) / (steps / 2);
    await page.mouse.move(x0 + (x1 - x0) * f, y);
    const wait = t0 + i * DRAG_STEP_MS - performance.now();
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  }
  const seconds = (performance.now() - t0) / 1000;
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __stop: boolean };
    w.__stop = true;
    return w.__frames;
  });
  await page.mouse.up();
  return frames / seconds;
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

/** The path with every symbolic link of its existing part resolved (`<out>` may not exist yet: its first existing parent is). */
async function canonical(path: string): Promise<string> {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      rest.unshift(relative(parent, existing));
      existing = parent;
    }
  }
}

async function main(): Promise<void> {
  const from = flag('--from');
  if (from !== undefined) {
    // `rm(live)` runs before the copy: a source in `<out>`, or one that holds `<out>`, would be deleted or copied into itself
    const inside = (a: string, b: string): boolean => {
      const r = relative(a, b);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    };
    const [src, dst] = [await canonical(from), await canonical(root)];
    if (inside(dst, src) || inside(src, dst))
      throw new Error(
        `--from ${from} is the output directory ${root}, inside it or above it: pass a separate copy`,
      );
  }
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
  // The download holds the manifest and the partitions only; a site to serve needs its shell (`--from` a full site, or a rebuild).
  if ((await sizeOf(join(dir, 'index.html'))) === null)
    throw new Error(
      `${dir} has no index.html: --no-rebuild needs a complete site (a --from copy of one); run without it to rebuild`,
    );
  print(await reportSize(dir).catch(() => 'report size: unavailable'));
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
    const fps: number[] = [];
    for (let i = 0; i < RUNS; i += 1)
      await measure(base, '#/dashboards/ci', async (page) => {
        fps.push(await dragFps(page));
      });
    print();
    print(
      `slider drag on #/dashboards/ci (${DRAG_MS} ms, ${RUNS} fresh contexts): ${median(fps).toFixed(1)} fps median, range ${Math.min(...fps).toFixed(1)}-${Math.max(...fps).toFixed(1)}`,
    );
  } finally {
    await server.close();
  }
}

await main();

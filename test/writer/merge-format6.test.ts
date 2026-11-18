import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mergeWith } from '../../src/api/convert.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import {
  isPartitioned,
  type ManifestV4,
  manifestAnchor,
  parseAnyManifest,
} from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { writeManifest } from '../../src/writer/checkpoint.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { openSession } from '../../src/writer/session.js';
import { asFormat5, withServiceShare } from '../../test-support/format6.js';
import { span, traceRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, EPOCH_NS, otlp, testConfig } from '../../test-support/writer-deps.js';
import { spanIdOf, spansRequest, traceIdOf } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merge-format6-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const real = () => {
  const w = createTestWriter();
  return { ...w, deps: { ...w.deps, fs: createNodeFileSystem() } };
};
const cfg = { writer: { format: 'site' as const } };

function manifestAt(out: string): {
  raw: { formatVersion?: unknown; epochUnixNano?: unknown };
  manifest: ManifestV4;
} {
  const text = readFileSync(join(dir, out, 'data/manifest.js'), 'utf8');
  const raw = reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)) as {
    formatVersion?: unknown;
    epochUnixNano?: unknown;
  };
  const manifest = parseAnyManifest(raw);
  if (!isPartitioned(manifest)) throw new Error('not a partition manifest');
  return { raw, manifest };
}

/** A report of one partition (spans from index `first`): format 6 with the flush's stored shares, or with `shares` false rewritten as format 5 without them. */
async function report(name: string, first: number, shares: boolean): Promise<void> {
  const w = real();
  const out = join(dir, name);
  const s = await openSession(w.deps, { out, config: testConfig(cfg), mode: 'replace' });
  await s.add(otlp(spansRequest(2, 0, first)), 'in.json');
  await s.close();
  const { manifest } = manifestAt(name);
  if (shares) await withServiceShare(out, manifest);
  else await asFormat5(out, manifest);
}

/** The input rewritten as format 6 without stored shares (an upgraded report): the manifest only. */
async function asFormat6(name: string): Promise<void> {
  const { manifest } = manifestAt(name);
  await writeManifest(createNodeFileSystem(), join(dir, name), { ...manifest, formatVersion: 6 });
}

const merge = (inputs: string[]) =>
  mergeWith({ inputs: inputs.map((i) => join(dir, i)), out: join(dir, 'm'), config: cfg }, real().deps);

describe('the format-6 test stand-in', () => {
  test('its manifest and anchor are what a reader derives, even from an epoch before range.start', async () => {
    await report('early', 0, false);
    const { manifest } = manifestAt('early');
    if (manifest.range === null) throw new Error('a range');
    const start = BigInt(manifest.range.start);
    const out = await withServiceShare(join(dir, 'early'), {
      ...manifest,
      epochUnixNano: String(start - 12345n),
    });
    expect(manifestAnchor(out)).toBe(start);
    expect(manifestAnchor(manifestAt('early').manifest)).toBe(start);
  });
});

describe('merge --compact and the service share', () => {
  test('a trace split between a format-5 copy and a format-6 flush is recomputed; one only in the copy stays null', async () => {
    const w = real();
    const out = join(dir, 'mixed');
    const s = await openSession(w.deps, { out, config: testConfig(cfg), mode: 'replace' });
    // flush 0: traces 0 and 1; flush 1: trace 1 again (a second span) and trace 2. Left unclosed: two partitions.
    const base = BigInt(EPOCH_NS);
    const one = (trace: number, id: number, at: bigint) =>
      span({
        traceId: traceIdOf(trace),
        spanId: spanIdOf(id),
        startTimeUnixNano: String(base + at),
        endTimeUnixNano: String(base + at + 500n),
      });
    const request = (spans: ReturnType<typeof one>[]) =>
      traceRequest(spans, [{ key: 'service.name', value: { stringValue: 'svc' } }]);
    await s.add(otlp(request([one(0, 0, 0n), one(1, 1, 1000n)])), 'a.json');
    await s.flush();
    await s.add(otlp(request([one(1, 2, 10_000n), one(2, 3, 11_000n)])), 'b.json');
    await s.flush();
    const five = await asFormat5(out, manifestAt('mixed').manifest);
    await withServiceShare(out, five, [1]);
    await mergeWith(
      {
        inputs: [out],
        out: join(dir, 'm'),
        config: { writer: { format: 'site' as const, compactOnMerge: true } },
      },
      real().deps,
    );
    const { raw, manifest } = manifestAt('m');
    expect(raw.formatVersion).toBe(8);
    expect(manifest.partitions).toHaveLength(1);
    expect(manifest.partitions[0]?.files.traces?.serviceShare).toBe(true);
    const file = manifest.partitions[0]?.files.traces;
    if (file === undefined) throw new Error('no traces file');
    const rows = decodeTable('traces', readFileSync(join(dir, 'm', file.path)));
    const shareOf = (n: number) =>
      Reflect.get(rows.find((r) => Reflect.get(r, 'trace_id') === traceIdOf(n)) ?? {}, 'service_share');
    expect(rows).toHaveLength(3);
    expect(shareOf(0)).toBeNull(); // only in the format-5 copy
    expect(shareOf(1)).toBe('[["svc","1000"]]'); // a span in each input, recomputed
    expect(shareOf(2)).toBe('[["svc","500"]]'); // only in the format-6 flush, kept
  });
});

describe('merge and format 6', () => {
  test('a format-6 and a format-5 input write format 6 without an epoch, the copy keeps serviceShare', async () => {
    await report('six', 0, true);
    await report('five', 10, false);
    await merge(['six', 'five']);
    const { raw, manifest } = manifestAt('m');
    expect(raw.formatVersion).toBe(8);
    expect(raw.epochUnixNano).toBeUndefined();
    expect(manifest.partitions).toHaveLength(2);
    const shared = manifest.partitions.map((p) => p.files.traces?.serviceShare);
    expect(shared.filter((v) => v === true)).toHaveLength(1);
    expect(shared.filter((v) => v === undefined)).toHaveLength(1);
  });
  test('format-5 inputs write format 6: the copies keep their files, the manifest drops the epoch', async () => {
    await report('a', 0, false);
    await report('b', 10, false);
    const sizes = (name: string) =>
      manifestAt(name)
        .manifest.partitions.flatMap((p) => Object.values(p.files).map((f) => f.bytes))
        .sort((x, y) => x - y);
    const before = [...sizes('a'), ...sizes('b')].sort((x, y) => x - y);
    await merge(['a', 'b']);
    const { raw } = manifestAt('m');
    expect(raw.formatVersion).toBe(8);
    expect(raw.epochUnixNano).toBeUndefined();
    expect(sizes('m')).toEqual(before); // every file copied byte for byte
    expect(manifestAt('m').manifest.partitions.every((p) => p.files.traces?.serviceShare === undefined)).toBe(
      true,
    );
  });
  test('an upgraded format-6 input without stored shares and a format-5 input write format 6', async () => {
    await report('up', 0, false);
    await asFormat6('up');
    await report('five', 10, false);
    await merge(['up', 'five']);
    const { raw, manifest } = manifestAt('m');
    expect(raw.formatVersion).toBe(8);
    expect(raw.epochUnixNano).toBeUndefined();
    expect(manifest.partitions.every((p) => p.files.traces?.serviceShare === undefined)).toBe(true);
  });
  test('a merged format-6 report whose range starts before its epoch reopens for append', async () => {
    const w = real();
    const out = join(dir, 'old');
    const s = await openSession(w.deps, { out, config: testConfig(cfg), mode: 'replace' });
    await s.add(otlp(spansRequest(2, 0, 20)), 'a.json');
    await s.add(otlp(spansRequest(2, -5_000_000_000, 30)), 'b.json');
    await s.close();
    await report('six', 0, true);
    await merge(['six', 'old']);
    expect(manifestAt('m').raw.formatVersion).toBe(8);
    const again = await openSession(real().deps, {
      out: join(dir, 'm'),
      config: testConfig(cfg),
      mode: 'append',
    });
    await again.add(otlp(spansRequest(2, 0, 40)), 'c.json');
    await again.close();
    expect(manifestAt('m').manifest.partitions.length).toBeGreaterThan(2);
  });
  test('an empty format-6 report reopens for append', async () => {
    const w = real();
    const out = join(dir, 'e');
    const s = await openSession(w.deps, { out, config: testConfig(cfg), mode: 'replace' });
    await s.close();
    await asFormat6('e');
    const again = await openSession(real().deps, { out, config: testConfig(cfg), mode: 'append' });
    await again.add(otlp(spansRequest(2, 0, 40)), 'c.json');
    await again.close();
    expect(manifestAt('e').manifest.partitions).toHaveLength(1);
  });
});

describe('appending to a format-5 report', () => {
  const DAY = 86_400_000_000_000;

  test('upgrades its manifest to format 6 in place, leaves the old partitions untouched, and takes data any distance away', async () => {
    await report('five', 0, false);
    const old = manifestAt('five').manifest.partitions;
    const oldFiles = old.flatMap((p) => Object.values(p.files)).map((f) => [f.path, f.bytes] as const);
    const before = oldFiles.map(([path]) => readFileSync(join(dir, 'five', path)));
    const w = real();
    const s = await openSession(w.deps, {
      out: join(dir, 'five'),
      config: testConfig(cfg),
      mode: 'append',
    });
    // Over 104 days past the report's epoch: a format-5 session could not take it.
    await s.add(otlp(spansRequest(2, 400 * DAY, 10)), 'late.json');
    await s.close();
    const { raw, manifest } = manifestAt('five');
    expect(raw.formatVersion).toBe(8);
    expect(raw.epochUnixNano).toBeUndefined();
    expect(manifest.totals.spans).toBe(4);
    expect(manifest.partitions.slice(0, old.length)).toEqual(old);
    expect(oldFiles.map(([path]) => readFileSync(join(dir, 'five', path)))).toEqual(before);
    expect(manifest.partitions.some((p) => p.files.traces?.serviceShare === true)).toBe(true);
    expect(BigInt(manifest.range?.end ?? 0)).toBeGreaterThan(BigInt(EPOCH_NS) + BigInt(399 * DAY));
  });

  test('a session without data still upgrades the manifest', async () => {
    await report('five', 0, false);
    const w = real();
    const s = await openSession(w.deps, { out: join(dir, 'five'), config: testConfig(cfg), mode: 'append' });
    await s.close();
    expect(manifestAt('five').raw.formatVersion).toBe(8);
    expect(manifestAt('five').raw.epochUnixNano).toBeUndefined();
  });
});

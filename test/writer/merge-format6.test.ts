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
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { writeManifest } from '../../src/writer/checkpoint.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { openSession } from '../../src/writer/session.js';
import { withServiceShare } from '../../test-support/format6.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

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

/** A format-5 report of one partition (spans from index `first`); with `shares` it is rewritten as format 6 with stored shares. */
async function report(name: string, first: number, shares: boolean): Promise<void> {
  const w = real();
  const out = join(dir, name);
  const s = await openSession(w.deps, { out, config: testConfig(cfg), mode: 'replace' });
  await s.add(otlp(spansRequest(2, 0, first)), 'in.json');
  await s.close();
  if (shares) await withServiceShare(out, manifestAt(name).manifest);
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

describe('merge and format 6', () => {
  test('a format-6 and a format-5 input write format 6 without an epoch, the copy keeps serviceShare', async () => {
    await report('six', 0, true);
    await report('five', 10, false);
    await merge(['six', 'five']);
    const { raw, manifest } = manifestAt('m');
    expect(raw.formatVersion).toBe(6);
    expect(raw.epochUnixNano).toBeUndefined();
    expect(manifest.partitions).toHaveLength(2);
    const shared = manifest.partitions.map((p) => p.files.traces?.serviceShare);
    expect(shared.filter((v) => v === true)).toHaveLength(1);
    expect(shared.filter((v) => v === undefined)).toHaveLength(1);
  });
  test('format-5 inputs write format 5', async () => {
    await report('a', 0, false);
    await report('b', 10, false);
    await merge(['a', 'b']);
    const { raw } = manifestAt('m');
    expect(raw.formatVersion).toBe(5);
    expect(raw.epochUnixNano).toBeDefined();
  });
  test('an upgraded format-6 input without stored shares and a format-5 input write format 6', async () => {
    await report('up', 0, false);
    await asFormat6('up');
    await report('five', 10, false);
    await merge(['up', 'five']);
    const { raw, manifest } = manifestAt('m');
    expect(raw.formatVersion).toBe(6);
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
    expect(manifestAt('m').raw.formatVersion).toBe(6);
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

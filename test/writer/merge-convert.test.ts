import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { mergeWith } from '../../src/api/convert.js';
import { decodeColumns } from '../../src/format/columns.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import type { Table } from '../../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { SPAN_COLUMNS } from '../../src/format/specs.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { SpanRecord } from '../../src/model/records.js';
import { mergeReports } from '../../src/writer/merge.js';
import { openSession } from '../../src/writer/session.js';
import { type JsonObject, logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { allSpans, cumulativeRequest, manifestOf, spansRequest } from './helpers.js';

const REPORTS = join(import.meta.dirname, '../../fixtures/reports');

async function copyFixture(w: TestWriter, name: string): Promise<void> {
  const root = join(REPORTS, name, 'data');
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = join(e.parentPath, e.name).slice(root.length + 1);
    await w.deps.fs.writeBytes(`${name}/data/${rel}`, readFileSync(join(root, rel)));
  }
}

function v4Manifest(w: TestWriter, out: string): ManifestV4 {
  const text = w.fs.snapshot().get(`${out}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  const m = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(m)) throw new Error('not a v4 manifest');
  return m;
}

async function rowsOf(w: TestWriter, out: string, table: Table) {
  const m = v4Manifest(w, out);
  const rows: object[] = [];
  for (const p of m.partitions) {
    const f = p.files[table];
    if (f === undefined) continue;
    rows.push(...decodeTable(table, await w.deps.fs.readBytes(`${out}/${f.path}`)));
  }
  return rows;
}

const cell = (row: object, key: string): unknown => Reflect.get(row, key);
const config = { writer: { format: 'site' as const } };

describe.each(['format-1', 'format-2', 'format-3'])('%s merged into a format-4 report', (name) => {
  test('keeps the span count, absolute times and point deltas', async () => {
    const w = createTestWriter();
    await copyFixture(w, name);
    const input = manifestOf(w, name);
    const summary = await mergeWith({ inputs: [name], out: 'm', config }, w.deps);
    expect(summary.totals).toEqual(input.totals);

    const m = v4Manifest(w, 'm');
    expect(m.totals).toEqual(input.totals);
    const spans = await rowsOf(w, 'm', 'spans');
    expect(spans).toHaveLength(input.totals.spans);

    // A known span: first row of the first input span chunk.
    const chunk = input.chunks.find((c) => c.signal === 'spans');
    if (chunk === undefined) throw new Error('no span chunk');
    const text = w.fs.snapshot().get(`${name}/${chunk.path}`) ?? '';
    const key = chunk.path.slice('data/'.length, -'.js'.length);
    const known = (
      decodeColumns(SPAN_COLUMNS, reviveDataJson(unwrapDataFile(text, key))).rows as SpanRecord[]
    )[0];
    if (known === undefined) throw new Error('empty chunk');
    const row = spans.find(
      (r) => cell(r, 'trace_id') === known.traceId && cell(r, 'span_id') === known.spanId,
    );
    expect(row === undefined ? undefined : cell(row, 'start_time_unix_nano')).toBe(
      BigInt(input.epochUnixNano) + BigInt(known.start),
    );

    const points = await rowsOf(w, 'm', 'points');
    expect(points).toHaveLength(input.totals.metrics);
    expect(points.some((p) => cell(p, 'delta_value') !== null || cell(p, 'delta_count') !== null)).toBe(true);
    // jobs.completed.cumulative reads 6, 10, ... at 10 s, 20 s, ... and restarts at 70 s with 6.
    const series = points.filter((p) => cell(p, 'metric_name') === 'jobs.completed.cumulative');
    const at = (sec: number) =>
      series.find(
        (p) => cell(p, 'time_unix_nano') === 1_700_000_000_000_000_000n + BigInt(sec) * 1_000_000_000n,
      );
    expect(at(20) && [cell(at(20) as object, 'delta_value'), cell(at(20) as object, 'reset')]).toEqual([
      4,
      false,
    ]);
    expect(at(70) && [cell(at(70) as object, 'delta_value'), cell(at(70) as object, 'reset')]).toEqual([
      6,
      true,
    ]);
  });
});

test('three inputs with the same spans are deduplicated and the earliest epoch is the output epoch', async () => {
  const w = createTestWriter();
  for (const n of ['format-1', 'format-2', 'format-3']) await copyFixture(w, n);
  const one = manifestOf(w, 'format-1');
  await mergeWith({ inputs: ['format-1', 'format-2', 'format-3'], out: 'm', config }, w.deps);
  const m = v4Manifest(w, 'm');
  expect(m.totals.spans).toBe(one.totals.spans);
  expect(m.epochUnixNano).toBe(one.epochUnixNano);
  // Points are not deduplicated: 3 x 230.
  expect(m.totals.metrics).toBe(3 * one.totals.metrics);
  expect(one.totals.metrics).toBe(230);
});

async function chunkReport(w: TestWriter, out: string, requests: readonly JsonObject[]): Promise<void> {
  const s = await openSession(w.deps, { out, config: testConfig(), mode: 'replace' });
  for (const [i, r] of requests.entries()) await s.add(otlp(r), `in-${i}.json`);
  await s.close();
}

describe('rebasing across epochs', () => {
  const SHIFT = 1_000_000_123n;

  test('a later-epoch input given first keeps exact absolute times and the earliest epoch wins', async () => {
    const w = createTestWriter();
    await copyFixture(w, 'format-3');
    const original = manifestOf(w, 'format-3');
    const lateEpoch = BigInt(original.epochUnixNano) + SHIFT;
    const file = 'format-3/data/manifest.js';
    const text = w.fs.snapshot().get(file) ?? '';
    expect(text).toContain(original.epochUnixNano);
    await w.deps.fs.writeTextAtomic(file, text.replace(original.epochUnixNano, lateEpoch.toString()));
    await chunkReport(w, 'early', [spansRequest(3, 0, 5000)]);
    const earlyEpoch = BigInt(manifestOf(w, 'early').epochUnixNano);
    expect(earlyEpoch).toBeLessThan(lateEpoch);

    await mergeWith({ inputs: ['format-3', 'early'], out: 'm', config }, w.deps);
    const m = v4Manifest(w, 'm');
    expect(m.epochUnixNano).toBe(earlyEpoch.toString());

    // The late input's spans: absolute = its (rewritten) epoch + relative start.
    const chunk = original.chunks.find((c) => c.signal === 'spans');
    if (chunk === undefined) throw new Error('no span chunk');
    const key = chunk.path.slice('data/'.length, -'.js'.length);
    const decoded = decodeColumns(
      SPAN_COLUMNS,
      reviveDataJson(unwrapDataFile(w.fs.snapshot().get(`format-3/${chunk.path}`) ?? '', key)),
    ).rows as SpanRecord[];
    const spans = await rowsOf(w, 'm', 'spans');
    expect(spans).toHaveLength(original.totals.spans + 3);
    for (const known of decoded.slice(0, 20)) {
      const row = spans.find(
        (r) => cell(r, 'trace_id') === known.traceId && cell(r, 'span_id') === known.spanId,
      );
      expect(row === undefined ? undefined : cell(row, 'start_time_unix_nano')).toBe(
        lateEpoch + BigInt(known.start),
      );
    }
    // And its points: the cumulative series' times are 10 s, 20 s, ... after the rewritten epoch's own rebase.
    const times = (await rowsOf(w, 'm', 'points'))
      .filter((p) => cell(p, 'metric_name') === 'jobs.completed.cumulative')
      .map((p) => cell(p, 'time_unix_nano'));
    const unshifted = (
      await (async () => {
        const w2 = createTestWriter();
        await copyFixture(w2, 'format-3');
        await mergeWith({ inputs: ['format-3'], out: 'u', config }, w2.deps);
        return rowsOf(w2, 'u', 'points');
      })()
    )
      .filter((p) => cell(p, 'metric_name') === 'jobs.completed.cumulative')
      .map((p) => cell(p, 'time_unix_nano'));
    expect(times).toHaveLength(10);
    expect(times).toEqual(unshifted.map((t) => (t as bigint) + SHIFT));
  });
});

describe('metric stream origins on the format-4 path', () => {
  test('sequential runs of one cumulative series are separate streams, not resets', async () => {
    const w = createTestWriter();
    await chunkReport(w, 'a', [
      cumulativeRequest('c', [
        [10, 4, 0],
        [20, 9, 0],
      ]),
    ]);
    await chunkReport(w, 'b', [
      cumulativeRequest('c', [
        [110, 3, 100],
        [120, 7, 100],
      ]),
    ]);
    await mergeWith({ inputs: ['a', 'b'], out: 'm', config }, w.deps);
    const points = (await rowsOf(w, 'm', 'points')).sort((x, y) =>
      Number((cell(x, 'time_unix_nano') as bigint) - (cell(y, 'time_unix_nano') as bigint)),
    );
    expect(points.map((p) => [cell(p, 'delta_value'), cell(p, 'reset')])).toEqual([
      [4, false],
      [5, false],
      [3, false],
      [4, false],
    ]);
  });
});

describe('format mismatch with an existing output (R54)', () => {
  test('merge as chunks into an existing format-4 report is a version-mismatch with the append hint', async () => {
    const w = createTestWriter();
    await chunkReport(w, 'in', [spansRequest(1)]);
    await mergeWith({ inputs: ['in'], out: 'out', config }, w.deps);
    const e = await mergeReports(w.deps, ['in'], { out: 'out', config: testConfig(), mode: 'open' }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(OtelHtmlError);
    expect(e).toMatchObject({ code: 'version-mismatch', hint: 'append with --format site' });
  });

  test('merge as site into an existing format-3 report is a version-mismatch with the merge hint', async () => {
    const w = createTestWriter();
    await chunkReport(w, 'in', [spansRequest(1)]);
    await chunkReport(w, 'out', [spansRequest(1, 0, 9)]);
    const e = await mergeReports(w.deps, ['in'], {
      out: 'out',
      config: testConfig({ writer: { format: 'site' } }),
      mode: 'open',
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({
      code: 'version-mismatch',
      hint: 'use merge to convert: `otel-html merge out -o <dir> --format site`',
    });
  });
});

describe('addRecords', () => {
  test('a ref outside the batch tables is an invalid-report', async () => {
    const w = createTestWriter();
    await chunkReport(w, 'in', [spansRequest(1)]);
    const span = allSpans(w, 'in')[0];
    if (span === undefined) throw new Error('no span');
    const epoch = BigInt(manifestOf(w, 'in').epochUnixNano) as never;
    for (const format of ['site'] as const) {
      const s = await openSession(w.deps, {
        out: `o-${format}`,
        config: testConfig({ writer: { format } }),
        mode: 'replace',
      });
      const e = await s
        .addRecords({ signal: 'spans', rows: [span], resources: [], scopes: [], epoch })
        .catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'invalid-report', path: 'rows[0].resource' });
      await s.abort();
    }
  });

  test('logs of a v3 input reach the log table and the pattern clusters', async () => {
    const w = createTestWriter();
    await chunkReport(w, 'in', [
      logsRequest([1, 2, 3].map((n) => logRecord({ body: { stringValue: `user ${n} logged in` } }))),
    ]);
    await mergeWith({ inputs: ['in'], out: 'm', config }, w.deps);
    expect(await rowsOf(w, 'm', 'logs')).toHaveLength(3);
    expect((await rowsOf(w, 'm', 'patterns')).length).toBeGreaterThan(0);
  });
});

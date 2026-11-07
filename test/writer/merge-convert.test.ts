import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { mergeWith } from '../../src/api/convert.js';
import { decodeColumns } from '../../src/format/columns.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import type { Table } from '../../src/format/parquet/schema.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { SPAN_COLUMNS } from '../../src/format/specs.js';
import type { SpanRecord } from '../../src/model/records.js';
import { createTestWriter, type TestWriter } from '../../test-support/writer-deps.js';
import { manifestOf } from './helpers.js';

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
});

import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isPartitioned, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { parseTraceId } from '../../src/model/ids.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { SpanQuery, TraceRow } from '../../src/viewer/data/results.js';
import { openSession } from '../../src/writer/session.js';
import { openFixtureDb } from '../../test-support/format4-fixture.js';
import { span, traceRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';

/**
 * The share a writer stores and the share the viewer scans from the spans are one computation. Write a report through a
 * real session (traces split over four flushes, some spans also present as provisional copies), open it with the real
 * DuckDB data source as written and again with every `serviceShare` flag removed (so the views give null and
 * `serviceShare` scans the spans), and compare.
 */

const TRACES = 20;
const FLUSHES = 4;
const T0 = 1_700_000_000_000_000_000n;
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const hex = (n: number, width: number): string => (n + 1).toString(16).padStart(width, '0');
const tracesQuery: SpanQuery = {
  condition: null,
  text: '',
  window: null,
  mode: 'traces',
  sort: { column: 'start', dir: 'asc' },
  limit: 1000,
  groupBy: null,
  measureBy: null,
  needs: ['rows'],
  facetKeys: null,
};

/** A small deterministic generator (an LCG), so a failure reproduces. */
function rng(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor((state / 2147483648) * n);
  };
}

function flushRequests(): object[] {
  const rnd = rng(7);
  const perFlush: { svc: string; sp: object }[][] = Array.from({ length: FLUSHES }, () => []);
  for (let t = 0; t < TRACES; t++) {
    const count = 2 + rnd(8);
    for (let s = 0; s < count; s++) {
      const parent = s === 0 ? undefined : hex(t * 100 + rnd(s), 16);
      const start = T0 + BigInt(t) * 10_000_000_000n + BigInt(rnd(1000)) * 1000n;
      const end = start + BigInt(rnd(5000) + 1) * 1000n;
      const svc = ['a', 'b', 'c'][rnd(3)] as string;
      const ids = {
        traceId: hex(t, 32),
        spanId: hex(t * 100 + s, 16),
        ...(parent === undefined ? {} : { parentSpanId: parent }),
        startTimeUnixNano: String(start),
        name: `op${s}`,
      };
      const flush = t < 10 ? t % FLUSHES : rnd(FLUSHES); // traces 10 and up are split across flushes
      perFlush[flush]?.push({ svc, sp: span({ ...ids, endTimeUnixNano: String(end) }) });
      if (rnd(5) === 0) {
        const provisional = span({
          ...ids,
          endTimeUnixNano: String(start + 500n),
          attributes: [{ key: 'otel_html.ci.provisional', value: { boolValue: true } }],
        });
        perFlush[(flush + 1) % FLUSHES]?.push({ svc, sp: provisional });
      }
    }
  }
  return perFlush.map((list) => {
    const bySvc = new Map<string, object[]>();
    for (const { svc, sp } of list) bySvc.set(svc, [...(bySvc.get(svc) ?? []), sp]);
    const resourceSpans: unknown[] = [];
    for (const [svc, spans] of bySvc) {
      const req = traceRequest(spans as never, [{ key: 'service.name', value: { stringValue: svc } }]);
      resourceSpans.push(...(req as { resourceSpans: unknown[] }).resourceSpans);
    }
    return { resourceSpans };
  });
}

async function writeReport(close: boolean) {
  const w = createTestWriter();
  const session = await openSession(w.deps, {
    out: 'r',
    config: testConfig({ writer: { format: 'site' } } as never),
    mode: 'replace',
  });
  let i = 0;
  for (const request of flushRequests()) {
    await session.add(otlp(request as never), `f${i++}`);
    await session.flush();
  }
  if (close) await session.close();
  const text = w.fs.snapshot().get('r/data/manifest.js');
  if (text === undefined) throw new Error('no manifest');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isPartitioned(manifest)) throw new Error('not a partition manifest');
  const files = new Map<string, Uint8Array>();
  for (const p of manifest.partitions)
    for (const t of TABLES) {
      const f = p.files[t];
      if (f) files.set(f.path, await w.fs.readBytes(`r/${f.path}`));
    }
  return { manifest, files };
}

async function open(manifest: ManifestV4, files: Map<string, Uint8Array>) {
  const db = await openFixtureDb({ manifest, files, epoch: BigInt(manifest.epochUnixNano) });
  const ds = createDuckDbDataSource({
    engine: mosaicQueryEngine(createCoordinator(db.connector, silent), db),
    manifest,
  });
  return {
    ds,
    close: async () => {
      await ds.close();
      db.close();
    },
  };
}

function withoutShareFlags(manifest: ManifestV4): ManifestV4 {
  return {
    ...manifest,
    partitions: manifest.partitions.map((p) => {
      const { traces, ...rest } = p.files;
      if (traces === undefined) return p;
      const { serviceShare: _flag, ...unflagged } = traces;
      return { ...p, files: { ...rest, traces: unflagged } };
    }),
  };
}

describe.each([
  { closed: true, partitions: 1 },
  { closed: false, partitions: FLUSHES },
])('stored service share against the span scan (closed: $closed)', ({ closed, partitions }) => {
  test('every exact stored share equals the scan, and serviceShare agrees either way', async () => {
    const { manifest, files } = await writeReport(closed);
    expect(manifest.partitions.length).toBe(partitions);
    const stored = await open(manifest, files);
    const scanned = await open(withoutShareFlags(manifest), files);
    try {
      const rows = (await stored.ds.querySpans(tracesQuery)).rows as TraceRow[];
      expect(rows.length).toBe(TRACES);
      let exact = 0;
      for (const row of rows) {
        const id = parseTraceId(row.traceId, 'traceId');
        const viaScan = await scanned.ds.serviceShare(id, undefined);
        if (row.share !== null) {
          exact++;
          expect(
            row.share.map(({ service, ns }) => ({ service, ns: Number(ns) })),
            row.traceId,
          ).toEqual(viaScan);
        }
        expect(await stored.ds.serviceShare(id, undefined), row.traceId).toEqual(viaScan);
      }
      // Compacted, every trace is in one row; unclosed, a trace split over flushes has no exact share but some do.
      if (closed) expect(exact).toBe(TRACES);
      else {
        expect(exact).toBeGreaterThan(0);
        expect(exact).toBeLessThan(TRACES);
      }
    } finally {
      await stored.close();
      await scanned.close();
    }
  });
});

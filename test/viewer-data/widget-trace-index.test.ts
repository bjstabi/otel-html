import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { andConditions } from '../../src/dashboards/conditions.js';
import { type VariableBinding, variableCondition } from '../../src/viewer/dashboards/scope.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { SpanQuery, SpanQueryResult } from '../../src/viewer/data/results.js';
import type { WidgetIndexHint } from '../../src/viewer/data/widget-index-route.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import { withoutIndexEvaluator, withoutWidgetIndex } from '../../test-support/rollup-fixture.js';
import { ciConfig, ciRequest, filler, T0 } from '../writer/widget-index-helpers.js';

// Most tests open fresh DuckDB engines: up to 4 times slower on a CI runner.
vi.setConfig({ testTimeout: 60_000 });

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const plain = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x)));

const HOUR = 3_600_000_000_000n;
const SECOND = 1_000_000_000n;
const at = (h: bigint, s = 0n): bigint => T0 + h * HOUR + s * SECOND;
/** The filler spans (another scope: no widget matches them) with times near the start of the report. */
const weight = (n: number, from: number) =>
  filler(n, from).map((s) => ({ ...s, start: T0 + BigInt(s.i), end: T0 + BigInt(s.i) + 5n }));

const WORKFLOW = 'cicd.pipeline.name';
const JOB = 'cicd.pipeline.task.name';

interface Opened {
  source: (hint?: boolean) => DataSource;
  prepared: string[][];
  epoch: bigint;
  close(): void;
}

async function open(f: Format4Fixture): Promise<Opened> {
  const db = await openFixtureDb(f);
  const prepared: string[][] = [];
  const engine = mosaicQueryEngine(
    createCoordinator(db.connector, silentLogger),
    db,
    true,
    undefined,
    async (paths) => {
      prepared.push([...paths]);
    },
  );
  const ds = createDuckDbDataSource({ engine, manifest: f.manifest });
  return { source: () => ds, prepared, epoch: f.epoch, close: () => db.close() };
}

let query: string;
let indexed: Format4Fixture;
let partly: Format4Fixture;
let stripped: Format4Fixture;
let unversioned: Format4Fixture;
const opened: Record<'indexed' | 'partly' | 'stripped' | 'unversioned', Opened> = {} as never;

beforeAll(async () => {
  const config = await ciConfig();
  const widget = config.dashboards
    .flatMap((d) => d.dashboard.widgets)
    .find((w) => w.type === 'traces' && w.query !== null);
  if (widget?.type !== 'traces' || widget.query === null) throw new Error('no traces widget');
  query = widget.query;
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/c');
  await fs.writeTextAtomic('/c/ci.yaml', await readFile('test-support/legacy-ci.otel-html.yaml', 'utf8'));
  const input = (await loadConfigFile(fs, '/c/ci.yaml')) as ConfigInput;
  indexed = await buildFormat4Report(
    [
      // one CI run whose job spans are flushed in two partitions
      ciRequest([
        { i: 1, start: at(0n), end: at(2n) },
        { i: 2, job: 'success', task: 'build', start: at(0n, 60n), end: at(0n, 120n) },
        ...weight(400, 100),
      ]),
      ciRequest([
        { i: 3, job: 'success', task: 'test', start: at(1n), end: at(1n, 5n) },
        { i: 4, trace: 1, run: '8', start: at(8n), end: at(8n, 9n) },
        { i: 5, trace: 1, run: '8', job: 'success', task: 'build', start: at(8n, 1n), end: at(8n, 5n) },
        ...weight(400, 1000),
      ]),
      // unrelated spans
      ciRequest(weight(400, 2000)),
      // a run whose job has an int-valued task name
      ciRequest([
        { i: 8, trace: 3, run: '10', start: at(20n), end: at(20n, 9n) },
        { i: 9, trace: 3, run: '10', job: 'success', taskInt: 5, start: at(20n, 1n), end: at(20n, 5n) },
        ...weight(400, 3000),
      ]),
    ],
    { config: input, close: false },
  );
  partly = withoutWidgetIndex(indexed, indexed.manifest.partitions[1]?.n);
  stripped = withoutWidgetIndex(indexed);
  unversioned = withoutIndexEvaluator(indexed);
  opened.indexed = await open(indexed);
  opened.partly = await open(partly);
  opened.stripped = await open(stripped);
  opened.unversioned = await open(unversioned);
});

afterAll(() => {
  for (const o of Object.values(opened)) o.close();
});

const bound = (...b: VariableBinding[]): VariableBinding[] => b;
const BINDINGS: readonly (readonly [string, VariableBinding[]])[] = [
  ['no variables', bound()],
  ['job bound', bound({ key: JOB, value: 'build', kind: 'string' })],
  [
    'job and workflow bound',
    bound({ key: JOB, value: 'build', kind: 'string' }, { key: WORKFLOW, value: 'ci', kind: 'string' }),
  ],
  ['job bound to the text of an int', bound({ key: JOB, value: '5', kind: 'string' })],
];

function requestOf(
  o: Opened,
  b: VariableBinding[],
  window: [bigint, bigint] | null,
  dir: 'asc' | 'desc',
  limit: number,
  needs: SpanQuery['needs'],
  cursor?: SpanQuery['cursor'],
): SpanQuery {
  const variables = variableCondition(b, 'span');
  return {
    condition: andConditions(query, variables),
    text: '',
    window: window === null ? null : { start: Number(window[0] - o.epoch), end: Number(window[1] - o.epoch) },
    mode: 'traces',
    sort: { column: 'start', dir },
    limit,
    groupBy: null,
    measureBy: null,
    needs,
    facetKeys: null,
    cursor: cursor ?? null,
  };
}

const hintOf = (b: VariableBinding[]): WidgetIndexHint => ({
  query,
  variables: variableCondition(b, 'span'),
  bindings: b.map(({ key, value }) => ({ key, value })),
});

/** Every page of the list, following `next` to the end: the rows, the first page's total, and each cursor. */
async function pages(
  o: Opened,
  make: (cursor: SpanQuery['cursor']) => SpanQuery,
  hint?: WidgetIndexHint,
): Promise<unknown> {
  const out: SpanQueryResult[] = [];
  let cursor: SpanQuery['cursor'] = null;
  for (let i = 0; i < 30; i++) {
    const q = make(cursor);
    const r = await o.source().querySpans(hint === undefined ? q : { ...q, widgetIndex: hint });
    out.push(r);
    if (r.next == null) break;
    cursor = r.next;
  }
  return out.map((r) => ({ rows: r.rows, total: r.total, next: r.next }));
}

const WINDOWS: readonly (readonly [string, [bigint, bigint] | null, boolean])[] = [
  ['no window', null, true],
  ['a long window', [at(-1n), at(30n)], true],
  ['a long window starting inside the first run', [at(0n, 1800n), at(30n)], true],
  ['a short window', [at(0n), at(3n)], false],
];
const spansRead = (o: Opened): boolean => o.prepared.some((p) => p.some((f) => f.endsWith('/spans.parquet')));

describe('a traces widget answers the same from the index as from the scan', () => {
  for (const [wName, window, routes] of WINDOWS) {
    for (const [bName, b] of BINDINGS) {
      for (const dir of ['desc', 'asc'] as const) {
        for (const limit of [1, 200]) {
          test(`${wName}, ${bName}, ${dir}, limit ${limit}`, async () => {
            const make = (cursor: SpanQuery['cursor']) =>
              requestOf(opened.indexed, b, window, dir, limit, ['rows', 'total'], cursor);
            const truth = await pages(opened.stripped, make);
            for (const o of [opened.indexed, opened.partly, opened.unversioned]) {
              expect(plain(await pages(o, make, hintOf(b)))).toEqual(plain(truth));
            }
            const first = (truth as { rows: unknown[]; total: number }[])[0];
            if (b.length === 0 || b[0]?.value === 'build') {
              expect(first?.total).toBeGreaterThan(0);
            }
            if (!routes) return;
            // total alone
            const totalOnly = (cursor: SpanQuery['cursor']) =>
              requestOf(opened.indexed, b, window, dir, limit, ['total'], cursor);
            expect(plain(await pages(opened.indexed, totalOnly, hintOf(b)))).toEqual(
              plain(await pages(opened.stripped, totalOnly)),
            );
          });
        }
      }
    }
  }

  test('the indexed report reads no spans.parquet under no window or a long one, and the short window does', async () => {
    const fresh = await open(indexed);
    try {
      for (const [, window, routes] of WINDOWS) {
        for (const [, b] of BINDINGS) {
          fresh.prepared.length = 0;
          await fresh.source().querySpans({
            ...requestOf(fresh, b, window, 'desc', 200, ['rows', 'total']),
            widgetIndex: hintOf(b),
          });
          expect(spansRead(fresh)).toBe(!routes);
          if (routes) {
            expect(fresh.prepared.flat().some((f) => f.endsWith('/widget_traces.parquet'))).toBe(true);
          }
        }
      }
      // the paged first page, a page after a cursor and the count alone read none either
      const b = BINDINGS[1]?.[1] ?? [];
      fresh.prepared.length = 0;
      const first = await fresh.source().querySpans({
        ...requestOf(fresh, b, null, 'desc', 1, ['rows', 'total']),
        widgetIndex: hintOf(b),
      });
      expect(first.next).not.toBeNull();
      await fresh.source().querySpans({
        ...requestOf(fresh, [], null, 'desc', 1, ['rows'], first.next),
        widgetIndex: hintOf([]),
      });
      expect(spansRead(fresh)).toBe(false);
    } finally {
      fresh.close();
    }
  });

  test('an index without the evaluator version is scanned: the stripped answer, spans read', async () => {
    const fresh = await open(unversioned);
    try {
      for (const [, b] of BINDINGS) {
        fresh.prepared.length = 0;
        const q = requestOf(fresh, b, null, 'desc', 200, ['rows', 'total']);
        const r = await fresh.source().querySpans({ ...q, widgetIndex: hintOf(b) });
        expect(plain(r)).toEqual(plain(await opened.stripped.source().querySpans(q)));
        expect(spansRead(fresh)).toBe(true);
        expect(fresh.prepared.flat().some((f) => f.endsWith('/widget_traces.parquet'))).toBe(false);
      }
    } finally {
      fresh.close();
    }
  });

  test('a partly indexed report reads the index of the routed partitions and the spans of the others', async () => {
    const fresh = await open(partly);
    try {
      const b: VariableBinding[] = [];
      await fresh
        .source()
        .querySpans({ ...requestOf(fresh, b, null, 'desc', 200, ['rows', 'total']), widgetIndex: hintOf(b) });
      const read = [...new Set(fresh.prepared.flat())];
      expect(read.filter((f) => f.endsWith('/spans.parquet'))).toHaveLength(1);
      expect(read.filter((f) => f.endsWith('/widget_traces.parquet'))).toHaveLength(2);
    } finally {
      fresh.close();
    }
  });

  test('a long window gives the scan total, by the trace start', async () => {
    const window: [bigint, bigint] = [at(0n, 1800n), at(30n)];
    for (const [, b] of BINDINGS) {
      const q = requestOf(opened.indexed, b, window, 'desc', 200, ['rows', 'total']);
      const a = await opened.indexed.source().querySpans({ ...q, widgetIndex: hintOf(b) });
      const s = await opened.stripped.source().querySpans(q);
      expect(a.total).toBe(s.total);
      expect(a.rows.length).toBe(s.rows.length);
    }
  });

  test('an int-valued binding with no hint gives the scan answer', async () => {
    const condition = andConditions(query, 'resource.attributes["cicd.pipeline.task.name"] == 5');
    const q = { ...requestOf(opened.indexed, [], null, 'desc', 200, ['rows', 'total']), condition };
    const a = await opened.indexed.source().querySpans(q);
    const s = await opened.stripped.source().querySpans(q);
    expect(plain(a)).toEqual(plain(s));
    expect(a.total).toBe(1);
  });

  test('a hint whose query is not the condition is ignored: the scan answer, spans read', async () => {
    const fresh = await open(indexed);
    try {
      const q = requestOf(fresh, [], null, 'desc', 200, ['rows', 'total']);
      const wrong = { ...hintOf([]), query: 'name == "other"' };
      const r = await fresh.source().querySpans({ ...q, widgetIndex: wrong });
      const s = await opened.stripped.source().querySpans(q);
      expect(plain(r)).toEqual(plain(s));
      expect(spansRead(fresh)).toBe(true);
      // text beside the condition also scans
      fresh.prepared.length = 0;
      await fresh.source().querySpans({ ...q, text: 'n', widgetIndex: hintOf([]) });
      expect(spansRead(fresh)).toBe(true);
    } finally {
      fresh.close();
    }
  });
});

import '../../src/writer/parquet-wasm-source.js';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import { resolveConfig } from '../../src/config/resolve.js';
import type { ResolvedConfig } from '../../src/config/schema.js';
import { conditionId, widgetTraceConditions } from '../../src/config/widget-traces.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isPartitioned, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import type { Row } from '../../src/format/parquet/rows.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { openSession } from '../../src/writer/session.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import type { JsonObject } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf, spanIdOf, tableRowsOf, traceIdOf } from './helpers.js';

const CI_YAML = '.github/otel-html-ci.yaml';
const T0 = 1_700_000_000_000_000_000n;

async function ciConfig(): Promise<ResolvedConfig> {
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/c');
  await fs.writeTextAtomic('/c/ci.yaml', await readFile(CI_YAML, 'utf8'));
  return resolveConfig({ file: await loadConfigFile(fs, '/c/ci.yaml'), env: {}, fileLabel: 'config.yaml' })
    .config;
}

const str = (key: string, value: string): JsonObject => ({ key, value: { stringValue: value } });

interface CiSpan {
  i: number;
  /** A root span has no parent; a job span has one and its job attributes. */
  job?: 'success' | 'skip';
  scope?: string;
  run?: string;
  task?: string;
  start?: bigint;
  end?: bigint;
  trace?: number;
  /** An extra attribute, for weight. */
  pad?: string;
}

/** One request holding each span in a resource of its own, as the CI publisher writes a run. */
function ciRequest(spans: readonly CiSpan[]): ReturnType<typeof otlp> {
  return otlp({
    resourceSpans: spans.map((s) => ({
      resource: {
        attributes: [
          str('cicd.pipeline.name', 'ci'),
          str('cicd.pipeline.run.id', s.run ?? '7'),
          ...(s.task === undefined ? [] : [str('cicd.pipeline.task.name', s.task)]),
        ],
      },
      scopeSpans: [
        {
          scope: { name: s.scope ?? 'otel-html-ci' },
          spans: [
            {
              traceId: traceIdOf(s.trace ?? 0),
              spanId: spanIdOf(s.i),
              ...(s.job === undefined ? {} : { parentSpanId: spanIdOf(1000) }),
              name: 'n',
              kind: 1,
              startTimeUnixNano: String(s.start ?? T0 + BigInt(s.i)),
              endTimeUnixNano: String(s.end ?? T0 + BigInt(s.i) + 5n),
              attributes: [
                ...(s.job === undefined
                  ? []
                  : [
                      str('cicd.pipeline.task.run.id', String(s.i)),
                      str('cicd.pipeline.task.run.result', s.job),
                    ]),
                ...(s.pad === undefined ? [] : [str('pad', s.pad)]),
              ],
            },
          ],
        },
      ],
    })),
  });
}

const noise = (i: number): string =>
  [0, 1, 2].map((k) => createHash('sha256').update(`${i}:${k}`).digest('hex')).join('');

/** Spans of another scope: they give the spans file the weight a real partition has, and match no widget. */
const filler = (n: number, from = 100): CiSpan[] =>
  Array.from({ length: n }, (_, k) => ({
    i: from + k,
    trace: from + k,
    scope: 'other',
    run: `filler-${from + k}`,
    pad: noise(from + k),
  }));

const indexRows = (w: ReturnType<typeof createTestWriter>, out = 'r'): Row[] =>
  tableRowsOf(w, out, 'widget_traces');
const told = (w: ReturnType<typeof createTestWriter>) =>
  w.logs.filter((l) => l.level === 'warn' && l.msg.startsWith('the widget trace index'));

describe('a flush writes widget_traces', () => {
  test('the rows of a CI run: the root and the non-skipped job, sorted, with the manifest entry', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
    await s.add(
      ciRequest([
        { i: 1 },
        { i: 2, job: 'success', task: 'build' },
        { i: 3, job: 'skip', task: 'test' },
        ...filler(400),
      ]),
      'a.json',
    );
    await s.flush();
    const spec = widgetTraceConditions(config.dashboards);
    const id = conditionId(spec.conditions[0]?.source ?? '');
    const file = manifestOf(w, 'r').partitions[0]?.files.widget_traces;
    expect(file?.widgetIndex).toEqual({
      conditions: [id],
      variables: ['cicd.pipeline.name', 'cicd.pipeline.run.id', 'cicd.pipeline.task.name'],
    });
    expect(indexRows(w)).toEqual([
      {
        condition: id,
        trace_id: traceIdOf(0),
        'var:cicd.pipeline.name': 'ci',
        'var:cicd.pipeline.run.id': '7',
        'var:cicd.pipeline.task.name': null,
      },
      {
        condition: id,
        trace_id: traceIdOf(0),
        'var:cicd.pipeline.name': 'ci',
        'var:cicd.pipeline.run.id': '7',
        'var:cicd.pipeline.task.name': 'build',
      },
    ]);
    expect(told(w)).toEqual([]);
  });

  test('spans with no match give a 0-row table with the entry; logs only give none', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
    await s.add(ciRequest([{ i: 1, scope: 'other' }]), 'a.json');
    await s.flush();
    const file = manifestOf(w, 'r').partitions[0]?.files.widget_traces;
    expect(file?.rows).toBe(0);
    expect(file?.widgetIndex?.variables).toHaveLength(3);
    await s.add(
      otlp({
        resourceLogs: [
          {
            resource: { attributes: [] },
            scopeLogs: [
              {
                scope: { name: 'x' },
                logRecords: [{ timeUnixNano: String(T0), body: { stringValue: 'hi' } }],
              },
            ],
          },
        ],
      }),
      'b.json',
    );
    await s.flush();
    const parts = manifestOf(w, 'r').partitions;
    expect(parts).toHaveLength(2);
    expect(parts[1]?.files.logs).toBeDefined();
    expect(parts[1]?.files.widget_traces).toBeUndefined();
  });

  test('a config with no traces widget writes none', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config: testConfig(), mode: 'replace' });
    await s.add(ciRequest([{ i: 1 }]), 'a.json');
    await s.flush();
    expect(manifestOf(w, 'r').partitions[0]?.files.widget_traces).toBeUndefined();
  });

  test('a partition whose index would weigh over 5 % of its spans refuses it, and says so once', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
    const run = (i: number): string =>
      `${i}-${'x'.repeat(200)}`.replace(/x/g, (_c, k: number) => 'abcdef'[(i + k) % 6] ?? 'a');
    const spans = Array.from({ length: 40 }, (_, k) => ({ i: k + 1, trace: k + 1, run: run(k) }));
    await s.add(ciRequest(spans), 'a.json');
    await s.flush();
    const source = widgetTraceConditions(config.dashboards).conditions[0]?.source;
    expect(manifestOf(w, 'r').partitions[0]?.files.widget_traces).toBeUndefined();
    expect(told(w)).toHaveLength(1);
    expect(told(w)[0]?.msg).toBe(
      'the widget trace index of this partition is not written: it would weigh over 5 % of the spans file',
    );
    expect(told(w)[0]?.attrs).toMatchObject({ conditions: [source] });
    await s.add(ciRequest(spans.map((x) => ({ ...x, i: x.i + 100, trace: x.trace + 100 }))), 'b.json');
    await s.flush();
    expect(told(w)).toHaveLength(1);
  });

  test('a flush of two matching spans 2^53 + 10 ns apart writes none, and says so once', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
    const far = T0 + BigInt(Number.MAX_SAFE_INTEGER);
    // the first add fixes the session's anchor, so later spans may lie 2^53 ns on either side of it
    await s.add(ciRequest([{ i: 1, scope: 'other', start: T0, end: T0 + 1n }]), 'a.json');
    await s.add(
      ciRequest([
        { i: 2, trace: 2, start: T0 - 10n, end: T0 - 5n },
        { i: 3, trace: 3, start: far - 5n, end: far },
      ]),
      'b.json',
    );
    await s.flush();
    const source = widgetTraceConditions(config.dashboards).conditions[0]?.source;
    expect(manifestOf(w, 'r').partitions[0]?.files.widget_traces).toBeUndefined();
    expect(told(w)).toHaveLength(1);
    expect(told(w)[0]?.msg).toBe(
      'the widget trace index of this partition is not written: its span times are more than 2^53 ns apart',
    );
    expect(told(w)[0]?.attrs).toEqual({ conditions: [source] });
  });
});

describe('a compaction writes widget_traces', () => {
  test('three flushes compact into one table holding the union of their rows', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
    for (const k of [0, 1, 2]) {
      await s.add(
        ciRequest([
          { i: 10 * k + 1, trace: k },
          { i: 10 * k + 2, trace: k, job: 'success', task: 'build' },
          ...filler(400, 100 + 1000 * k),
        ]),
        `${k}.json`,
      );
      await s.flush();
    }
    const flushed = indexRows(w);
    expect(flushed).toHaveLength(6);
    await s.close();
    expect(manifestOf(w, 'r').partitions).toHaveLength(1);
    expect(manifestOf(w, 'r').partitions[0]?.files.widget_traces?.widgetIndex?.conditions).toHaveLength(1);
    expect(indexRows(w)).toEqual(flushed);
  });
});

describe('appending to an older report', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test.each([5, 6])(
    'a format-%i report appended to is written as format 7 and lists widget_traces',
    async (format) => {
      const dir = mkdtempSync(join(tmpdir(), 'widget-index-append-'));
      dirs.push(dir);
      cpSync(`fixtures/reports/format-${format}`, dir, { recursive: true });
      const before = JSON.parse(
        JSON.stringify(
          reviveDataJson(unwrapDataFile(readFileSync(join(dir, 'data/manifest.js'), 'utf8'), MANIFEST_KEY)),
        ),
      ) as { formatVersion: number; otelHtmlVersion: string };
      expect(before.formatVersion).toBe(format);
      const w = createTestWriter({ version: before.otelHtmlVersion });
      const deps = { ...w.deps, fs: createNodeFileSystem() };
      const s = await openSession(deps, { out: dir, config: await ciConfig(), mode: 'append' });
      await s.add(ciRequest([{ i: 1 }, ...filler(400)]), 'a.json');
      await s.close();
      const raw = reviveDataJson(
        unwrapDataFile(readFileSync(join(dir, 'data/manifest.js'), 'utf8'), MANIFEST_KEY),
      );
      expect((raw as { formatVersion: number }).formatVersion).toBe(7);
      const m = parseAnyManifest(raw);
      if (!isPartitioned(m)) throw new Error('not a partition manifest');
      const withIndex = m.partitions.filter((p) => p.files.widget_traces !== undefined);
      expect(withIndex.length).toBeGreaterThan(0);
      const path = withIndex[0]?.files.widget_traces?.path ?? '';
      expect(decodeTable('widget_traces', readFileSync(join(dir, path)))).toHaveLength(1);
    },
  );
});

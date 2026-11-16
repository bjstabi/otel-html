import '../../src/writer/parquet-wasm-source.js';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedConfig } from '../../src/config/schema.js';
import { widgetTraceConditions } from '../../src/config/widget-traces.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { mergeReports } from '../../src/writer/merge.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf, tableRowsOf } from './helpers.js';
import { type CiSpan, ciConfig, ciRequest, filler } from './widget-index-helpers.js';

const reads = vi.hoisted(() => ({ tables: [] as string[] }));
vi.mock('../../src/format/parquet/stream.js', async (orig) => {
  const mod = await orig<typeof import('../../src/format/parquet/stream.js')>();
  return {
    ...mod,
    readColumns: (...args: Parameters<typeof mod.readColumns>) => {
      reads.tables.push(args[0]);
      return mod.readColumns(...args);
    },
  };
});

const told = (w: ReturnType<typeof createTestWriter>) =>
  w.logs.filter((l) => l.level === 'warn' && l.msg.startsWith('the widget trace index'));

const SPANS: CiSpan[] = [
  { i: 1 },
  { i: 2, job: 'success', task: 'build' },
  { i: 3, job: 'skip', task: 'test' },
  ...filler(400),
];

async function write(
  w: ReturnType<typeof createTestWriter>,
  out: string,
  config: ResolvedConfig,
  spans = SPANS,
) {
  const s = await openSession(w.deps, { out, config, mode: 'replace' });
  await s.add(ciRequest(spans), 'a.json');
  await s.close();
}

const merge = (w: ReturnType<typeof createTestWriter>, from: string, config: ResolvedConfig, out = 'm') =>
  mergeReports(w.deps, [from], { out, config, mode: 'replace' });

/** The CI config without the `task.name` variable: its index has two variable columns. */
async function configWithoutJob(): Promise<ResolvedConfig> {
  const c = await ciConfig();
  return {
    ...c,
    dashboards: c.dashboards.map((d) => ({
      ...d,
      dashboard: {
        ...d.dashboard,
        variables: d.dashboard.variables.filter((v) => v.key !== 'cicd.pipeline.task.name'),
      },
    })),
  };
}

/** The CI config with no traces widget: it names dashboards (so a merge does not inherit the input's) and indexes nothing. */
async function configWithoutTraces(): Promise<ResolvedConfig> {
  const c = await ciConfig();
  return {
    ...c,
    dashboards: c.dashboards.map((d) => ({
      ...d,
      dashboard: { ...d.dashboard, widgets: d.dashboard.widgets.filter((w) => w.type !== 'traces') },
    })),
  };
}

beforeEach(() => {
  reads.tables.length = 0;
});

describe('a merge and the widget trace index of the partitions it copies', () => {
  test('a format 7 input written without dashboards gets the rows a flush with the config writes', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    await write(w, 'plain', testConfig());
    await write(w, 'ref', config);
    expect(manifestOf(w, 'plain').partitions[0]?.files.widget_traces).toBeUndefined();
    await merge(w, 'plain', config);
    const ref = manifestOf(w, 'ref').partitions[0]?.files.widget_traces;
    const got = manifestOf(w, 'm').partitions[0]?.files.widget_traces;
    expect(got?.widgetIndex).toEqual(ref?.widgetIndex);
    expect(got?.rows).toBe(2);
    expect(tableRowsOf(w, 'm', 'widget_traces')).toEqual(tableRowsOf(w, 'ref', 'widget_traces'));
    expect(told(w)).toEqual([]);
  });

  test('a format 6 report gets a widget_traces per partition with spans', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-widget-index-'));
    try {
      cpSync(join(import.meta.dirname, '../../fixtures/reports/format-6'), join(dir, 'in'), {
        recursive: true,
      });
      const w = createTestWriter();
      const deps = { ...w.deps, fs: createNodeFileSystem() };
      const config = await ciConfig();
      await mergeReports(deps, [join(dir, 'in')], { out: join(dir, 'm'), config, mode: 'replace' });
      const spec = widgetTraceConditions(config.dashboards);
      const { readFileSync } = await import('node:fs');
      const { reviveDataJson, unwrapDataFile } = await import('../../src/format/data-file.js');
      const { isPartitioned, parseAnyManifest } = await import('../../src/format/manifest.js');
      const { MANIFEST_KEY } = await import('../../src/format/paths.js');
      const m = parseAnyManifest(
        reviveDataJson(unwrapDataFile(readFileSync(join(dir, 'm/data/manifest.js'), 'utf8'), MANIFEST_KEY)),
      );
      if (!isPartitioned(m)) throw new Error('not partitioned');
      const withSpans = m.partitions.filter((p) => p.files.spans !== undefined);
      expect(withSpans.length).toBeGreaterThan(0);
      for (const p of withSpans) {
        const f = p.files.widget_traces;
        expect(f?.widgetIndex).toEqual({
          conditions: spec.conditions.map((c) => c.id),
          variables: spec.variables,
        });
        expect(
          decodeTable('widget_traces', new Uint8Array(readFileSync(join(dir, 'm', f?.path ?? '')))),
        ).toHaveLength(f?.rows ?? -1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an input written with the same config has its widget_traces copied byte for byte', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    await write(w, 'in', config);
    reads.tables.length = 0;
    await merge(w, 'in', config);
    const from = manifestOf(w, 'in').partitions[0]?.files.widget_traces;
    const to = manifestOf(w, 'm').partitions[0]?.files.widget_traces;
    expect(to?.widgetIndex).toEqual(from?.widgetIndex);
    expect(to?.rows).toBe(from?.rows);
    const a = await w.fs.readBytes(`in/${from?.path}`);
    const b = await w.fs.readBytes(`m/${to?.path}`);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(reads.tables).toEqual([]);
  });

  test('an input whose index lacks a variable column is recomputed with it', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    await write(w, 'in', await configWithoutJob());
    expect(manifestOf(w, 'in').partitions[0]?.files.widget_traces?.widgetIndex?.variables).toHaveLength(2);
    await write(w, 'ref', config);
    await merge(w, 'in', config);
    expect(manifestOf(w, 'm').partitions[0]?.files.widget_traces?.widgetIndex?.variables).toHaveLength(3);
    expect(tableRowsOf(w, 'm', 'widget_traces')).toEqual(tableRowsOf(w, 'ref', 'widget_traces'));
  });

  test('an input whose index holds more variables than the report is copied as it is', async () => {
    const wide = await ciConfig();
    const w = createTestWriter();
    await write(w, 'in', wide);
    await merge(w, 'in', await configWithoutJob());
    const from = manifestOf(w, 'in').partitions[0]?.files.widget_traces;
    const to = manifestOf(w, 'm').partitions[0]?.files.widget_traces;
    expect(to?.widgetIndex).toEqual(from?.widgetIndex);
  });

  test('a report that indexes nothing does not copy a widget_traces', async () => {
    const w = createTestWriter();
    await write(w, 'in', await ciConfig());
    await merge(w, 'in', await configWithoutTraces());
    expect(manifestOf(w, 'm').partitions[0]?.files.widget_traces).toBeUndefined();
    expect(manifestOf(w, 'm').partitions[0]?.files.spans).toBeDefined();
  });

  test('spans.parquet is read once, and decoded once for a rollup repair and the index together', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    await write(w, 'in', testConfig());
    const spansPath = `in/${manifestOf(w, 'in').partitions[0]?.files.spans?.path}`;
    let reading = 0;
    const fs = {
      ...w.fs,
      readBytes: (p: string) => {
        if (p === spansPath) reading += 1;
        return w.fs.readBytes(p);
      },
    };
    const keyed: ResolvedConfig = {
      ...config,
      writer: { ...config.writer, statisticsKeys: ['resource:cicd.pipeline.run.id'] },
    };
    reads.tables.length = 0;
    await mergeReports({ ...w.deps, fs }, ['in'], { out: 'm', config: keyed, mode: 'replace' });
    expect(manifestOf(w, 'm').partitions[0]?.files.span_rollups?.rollup?.dimensions).toContain(
      'resource:cicd.pipeline.run.id',
    );
    expect(manifestOf(w, 'm').partitions[0]?.files.widget_traces).toBeDefined();
    expect(reading).toBe(1);
    expect(reads.tables.filter((t) => t === 'spans')).toHaveLength(1);
  });

  test('a computed index is refused over 5 % of the spans, with the flush warning once', async () => {
    const config = await ciConfig();
    const w = createTestWriter();
    const run = (i: number): string =>
      `${i}-${'x'.repeat(200)}`.replace(/x/g, (_c, k: number) => 'abcdef'[(i + k) % 6] ?? 'a');
    const spans = Array.from({ length: 40 }, (_, k) => ({ i: k + 1, trace: k + 1, run: run(k) }));
    await write(w, 'in', testConfig(), spans);
    await merge(w, 'in', config);
    expect(manifestOf(w, 'm').partitions[0]?.files.widget_traces).toBeUndefined();
    expect(told(w)).toHaveLength(1);
    expect(told(w)[0]?.msg).toBe(
      'the widget trace index of this partition is not written: it would weigh over 5 % of the spans file',
    );
  });
});

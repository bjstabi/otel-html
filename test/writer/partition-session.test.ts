import { describe, expect, test, vi } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { LOCK_PATH, MANIFEST_KEY } from '../../src/format/paths.js';
import { parseAnySessionState, type SessionStateV2 } from '../../src/format/state.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { writeManifest, writeStateSlotV2 } from '../../src/writer/checkpoint.js';
import { openSession, type WriterSession } from '../../src/writer/session.js';
import {
  logRecord,
  logsRequest,
  metricsRequest,
  span,
  traceRequest,
} from '../../test-support/otlp-builders.js';
import {
  createTestWriter,
  EPOCH_NS,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';

const columnsFault = vi.hoisted(() => ({ fail: (): boolean => false }));
vi.mock('../../src/format/parquet/codec.js', async (original) => {
  const real = await original<typeof import('../../src/format/parquet/codec.js')>();
  return {
    ...real,
    columnsOfBatch: (...args: Parameters<typeof real.columnsOfBatch>) => {
      if (columnsFault.fail()) throw new Error('injected read fault');
      return real.columnsOfBatch(...args);
    },
  };
});

import { copyFrozenReport, spanIdOf, spansRequest, traceIdOf } from './helpers.js';

const OUT = 'r';

function cfg(extra: NonNullable<ConfigInput['writer']> = {}, rest: ConfigInput = {}) {
  return testConfig({ ...rest, writer: { format: 'site', ...extra } });
}

function open(w: TestWriter, config = cfg(), mode: 'open' | 'append' | 'replace' = 'replace') {
  return openSession(w.deps, { out: OUT, config, mode });
}

function manifest(w: TestWriter): ManifestV4 {
  const text = w.fs.snapshot().get(`${OUT}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  const m = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(m)) throw new Error('not a v4 manifest');
  return m;
}

function state(w: TestWriter, slot: 0 | 1): SessionStateV2 {
  const text = w.fs.snapshot().get(`${OUT}/data/state/session.${slot}.json`);
  if (text === undefined) throw new Error(`no state slot ${slot}`);
  const s = parseAnySessionState(JSON.parse(text));
  if (s.formatVersion !== 2) throw new Error('not a v2 state');
  return s;
}

const logs = (n: number) => otlp(logsRequest(Array.from({ length: n }, () => logRecord())));
const spans = (n: number, offset = 0, first = 0) => otlp(spansRequest(n, offset, first));

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

async function spanIds(w: TestWriter, n: number): Promise<string[]> {
  const bytes = await w.fs.readBytes(`${OUT}/data/partitions/${String(n).padStart(6, '0')}/spans.parquet`);
  return decodeTable('spans', bytes).map((r) => String(Reflect.get(r, 'span_id')));
}

describe('PartitionSession', () => {
  test('flush writes one partition with a table file per signal that has rows', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(3), 'a.json');
    await s.add(logs(2), 'b.json');
    await s.flush();
    const m = manifest(w);
    expect(m.formatVersion).toBe(4);
    expect(m.partitions).toHaveLength(1);
    expect(m.partitions[0]?.source).toBe('flush:0');
    expect(m.partitions[0]?.files.spans?.rows).toBe(3);
    expect(m.partitions[0]?.files.logs?.rows).toBe(2);
    expect(m.partitions[0]?.files.points).toBeUndefined();
    expect(m.totals).toEqual({ spans: 3, logs: 2, metrics: 0 });
    expect(m.complete).toBe(false);
    expect(m.engine).toEqual({ version: '1.32.0', format: 'site', assetsBase: 'assets/' });
    expect(m.statisticsKeys.spans).toContain('service_name');
    // spansRequest: span i starts at EPOCH_NS + i*1000 and ends 500 later; the logs sit at the builders' T0.
    const logT = BigInt(String(Reflect.get(logRecord(), 'timeUnixNano')));
    const spanStart = BigInt(EPOCH_NS);
    const spanEnd = spanStart + 2000n + 500n;
    const times = [logT, spanStart, spanEnd].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(m.range).toEqual({ start: String(times[0]), end: String(times[2]) });
    expect([...w.fs.snapshot().keys()].some((k) => k.includes('data/chunks'))).toBe(false);
    expect(w.fs.snapshot().has(`${OUT}/index.html`)).toBe(true);
    await s.close();
  });

  test('a flush with only spans writes no logs file and lists none', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(2), 'a.json');
    await s.flush();
    const entry = manifest(w).partitions[0];
    expect(Object.keys(entry?.files ?? {})).toEqual(['spans', 'traces']);
    expect(await w.fs.exists(`${OUT}/data/partitions/000000/logs.parquet`)).toBe(false);
    await s.close();
  });

  test('the next add and flush make partition 1', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.flush();
    await s.add(spans(1, 0, 5), 'b.json');
    await s.flush();
    expect(manifest(w).partitions.map((p) => [p.n, p.source])).toEqual([
      [0, 'flush:0'],
      [1, 'flush:1'],
    ]);
    await s.close();
  });

  test('a flush with nothing held and nothing changed writes nothing new', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.flush();
    const before = w.fs.snapshot();
    await s.flush();
    expect(w.fs.snapshot()).toEqual(before);
    expect(w.fs.snapshot().has(`${OUT}/data/state/session.1.json`)).toBe(false);
    await s.close();
  });

  test('close marks the manifest complete and releases the lock', async () => {
    const w = createTestWriter();
    const s = await open(w);
    expect(w.fs.snapshot().has(`${OUT}/${LOCK_PATH}`)).toBe(true);
    await s.add(spans(2), 'a.json');
    const summary = await s.close();
    expect(summary.totals).toEqual({ spans: 2, logs: 0, metrics: 0 });
    expect(manifest(w).complete).toBe(true);
    expect(w.fs.snapshot().has(`${OUT}/${LOCK_PATH}`)).toBe(false);
    const again = await open(w, cfg(), 'open');
    await again.abort();
  });

  test('the lock is held while open', async () => {
    const w = createTestWriter();
    const s = await open(w);
    expect((await failure(open(w))).code).toBe('report-locked');
    await s.abort();
  });

  test('a repeated span id is a duplicate; a drop condition drops', async () => {
    const w = createTestWriter();
    const s = await open(w, cfg({ drop: { traces: { span: ['name == "drop-me"'] } } }));
    expect(await s.add(spans(2), 'a.json')).toEqual({ accepted: 2, dropped: 0, duplicates: 0 });
    expect(await s.add(spans(2), 'b.json')).toEqual({ accepted: 0, dropped: 0, duplicates: 2 });
    const dropAll = cfg({ drop: { traces: { span: ['true'] } } });
    await s.close();
    const d = await open(createTestWriter(), dropAll);
    expect((await d.add(spans(2), 'a.json')).dropped).toBe(2);
    await d.abort();
  });

  test('append resumes nextPartition and the dedupe set from state v2', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(2), 'a.json');
    await s.flush();
    await s.abort();
    const a = await open(w, cfg(), 'append');
    expect(await a.add(spans(2), 'again.json')).toMatchObject({ accepted: 0, duplicates: 2 });
    await a.add(spans(1, 0, 9), 'b.json');
    await a.flush();
    expect(manifest(w).partitions.map((p) => p.n)).toEqual([0, 1]);
    expect(manifest(w).totals.spans).toBe(3);
    await a.abort();
  });

  test('append after close continues totals and partitions, and starts a new flush list', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(2), 'a.json');
    await s.close();
    const a = await open(w, cfg(), 'append');
    await a.add(spans(1, 0, 7), 'b.json');
    await a.flush();
    const m = manifest(w);
    expect(m.complete).toBe(false);
    expect(m.totals.spans).toBe(3);
    expect(m.partitions.map((p) => p.n)).toEqual([0, 1]);
    const slots = ([0, 1] as const).map((i) => state(w, i));
    expect(slots.some((st) => st.nextPartition === 2 && st.flushPartitions.join() === '1')).toBe(true);
    await a.close();
    expect(manifest(w).complete).toBe(true);
  });

  test('a crash between the state write and the manifest commit resumes from the committed partitions', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.flush();
    await s.add(spans(1, 0, 4), 'b.json');
    w.fs.failNextWrite('data/manifest.js');
    await expect(s.flush()).rejects.toThrow();
    expect(manifest(w).partitions).toHaveLength(1);
    await s.abort();
    const a = await open(w, cfg(), 'append');
    // The second batch was never committed, so it is accepted again and written over the orphan partition.
    expect(await a.add(spans(1, 0, 4), 'b.json')).toMatchObject({ accepted: 1 });
    await a.flush();
    expect(manifest(w).partitions.map((p) => p.n)).toEqual([0, 1]);
    expect(await spanIds(w, 1)).toEqual([spanIdOf(4)]);
    await a.abort();
  });

  test('a failed checkpoint is retried in the same session and lists every cut partition once', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    w.fs.failNextWrite('data/manifest.js');
    await expect(s.flush()).rejects.toThrow();
    await s.add(spans(1, 0, 3), 'b.json');
    await s.flush();
    expect(manifest(w).partitions.map((p) => p.n)).toEqual([0, 1]);
    expect(manifest(w).totals.spans).toBe(2);
    await s.close();
  });

  test('rows added while a checkpoint writes land in the next partition', async () => {
    const w = createTestWriter();
    const s = await open(w, cfg({ chunkTargetBytes: 1 }));
    const gate = w.fs.holdNextWrite('000000/spans.parquet');
    await s.add(spans(1), 'a.json'); // the size rule starts a background checkpoint that stops at the gate
    await gate.reached;
    await s.add(spans(1, 0, 3), 'b.json');
    gate.release();
    await s.flush();
    expect(manifest(w).partitions.map((p) => p.n)).toEqual([0, 1]);
    expect(await spanIds(w, 0)).toEqual([spanIdOf(0)]);
    expect(await spanIds(w, 1)).toEqual([spanIdOf(3)]);
    await s.close();
  });

  test('the idle timer checkpoints a session with new records', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() => expect(w.fs.snapshot().has(`${OUT}/data/manifest.js`)).toBe(true));
    expect(manifest(w).partitions).toHaveLength(1);
    await s.close();
  });

  test('replacing a report removes its partitions', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.add(logs(1), 'l.json');
    await s.close();
    expect(await w.fs.exists(`${OUT}/data/partitions/000000/logs.parquet`)).toBe(true);
    const r = await open(w);
    await r.add(spans(1, 0, 8), 'c.json');
    await r.close();
    expect(await w.fs.exists(`${OUT}/data/partitions/000000/logs.parquet`)).toBe(false);
    expect(manifest(w).partitions).toHaveLength(1);
    expect(manifest(w).totals).toEqual({ spans: 1, logs: 0, metrics: 0 });
  });

  test('an empty merge batch accepts nothing', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const r = await s.addRecords({
      signal: 'spans',
      rows: [],
      resources: [],
      scopes: [],
      epoch: 0n as never,
    });
    expect(r).toEqual({ accepted: 0, dropped: 0, duplicates: 0 });
    await s.abort();
  });

  test('a partial input holds its rows until endInput', async () => {
    const w = createTestWriter();
    const s = await open(w, cfg({ chunkTargetBytes: 1 }));
    await s.add(spans(1), 'a.json', { partial: true });
    expect(w.fs.snapshot().has(`${OUT}/data/manifest.js`)).toBe(false);
    await s.endInput();
    await s.flush();
    expect(manifest(w).totals.spans).toBe(1);
    await s.close();
  });
});

describe('rows that do not fit their columns', () => {
  test('uint32 flags and dropped counts are stored and round-trip', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const big = {
      flags: 0xffffffff,
      droppedAttributesCount: 4294967295,
      droppedEventsCount: 2147483648,
      droppedLinksCount: 3000000000,
    };
    await s.add(otlp(traceRequest([span(big)])), 'a.json');
    await s.add(
      otlp(logsRequest([logRecord({ flags: 0xffffffff, droppedAttributesCount: 4294967295 })])),
      'l.json',
    );
    await s.flush();
    const sp = decodeTable('spans', await w.fs.readBytes(`${OUT}/data/partitions/000000/spans.parquet`));
    expect(sp[0]).toMatchObject({
      flags: 4294967295n,
      dropped_attributes_count: 4294967295n,
      dropped_events_count: 2147483648n,
      dropped_links_count: 3000000000n,
    });
    const lg = decodeTable('logs', await w.fs.readBytes(`${OUT}/data/partitions/000000/logs.parquet`));
    expect(lg[0]).toMatchObject({ flags: 4294967295n, dropped_attributes_count: 4294967295n });
    await s.close();
  });

  test('a record the codec cannot encode is rejected with its request and later flushes still succeed', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    // `kind` is an int32 column and the JSON parser only admits enum values, so the request is edited after parsing.
    const bad = otlp(traceRequest([span({ spanId: spanIdOf(9) }), span({ spanId: spanIdOf(10) })]));
    if (bad.signal !== 'traces') throw new Error('expected traces');
    const first = bad.request.resourceSpans[0]?.scopeSpans[0]?.spans[1];
    if (first === undefined) throw new Error('no span');
    Reflect.set(first, 'kind', 3000000000);
    const e = await failure(s.add(bad, 'bad.json'));
    expect(e.code).toBe('invalid-otlp');
    await s.add(spans(1, 0, 5), 'b.json');
    await s.flush();
    expect(manifest(w).totals.spans).toBe(2);
    expect(await spanIds(w, 0)).toHaveLength(2);
    await s.close();
  });
});

describe('a partial input larger than the target', () => {
  test('is cut into several partitions as it is read, and nothing is listed before the input completes', async () => {
    const w = createTestWriter();
    const s = await open(w, cfg({ chunkTargetBytes: 2000 }));
    for (let i = 0; i < 6; i++) await s.add(spans(10, 0, i * 10), 'in.json', { partial: true });
    expect(w.fs.snapshot().has(`${OUT}/data/manifest.js`)).toBe(false);
    const files = [...w.fs.snapshot().keys()].filter((k) => k.endsWith('spans.parquet'));
    expect(files.length).toBeGreaterThan(1);
    await s.endInput();
    await s.flush();
    const m = manifest(w);
    expect(m.partitions.length).toBeGreaterThan(1);
    expect(m.partitions.map((p) => p.n)).toEqual(m.partitions.map((_, i) => i));
    expect(m.totals.spans).toBe(60);
    expect(m.partitions.reduce((n, p) => n + (p.files.spans?.rows ?? 0), 0)).toBe(60);
    await s.close();
  });

  test('a replacing input still holds its rows until the input completes', async () => {
    const w = createTestWriter();
    const first = await open(w);
    await first.add(spans(1), 'old.json');
    await first.close();
    const s = await open(w, cfg({ chunkTargetBytes: 1 }));
    await s.add(spans(10, 0, 100), 'in.json', { partial: true });
    expect(await w.fs.exists(`${OUT}/data/partitions/000000/spans.parquet`)).toBe(true);
    expect(manifest(w).totals.spans).toBe(1);
    await s.endInput();
    await s.close();
    expect(manifest(w).totals.spans).toBe(10);
  });
});

describe('statistics keys and state validation', () => {
  test('of two state slots that match the manifest, the one with the higher checkpoint is resumed', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.flush();
    await s.abort();
    const old = state(w, 0);
    expect(old).toMatchObject({ checkpoint: 1, flushPartitions: [0] });
    // Same nextPartition and epoch, so both slots match; only the newer one knows partition 0 is already compacted.
    await writeStateSlotV2(w.fs, OUT, 1, { ...old, checkpoint: 2, flushPartitions: [] });
    const r = await open(w, cfg(), 'append');
    await r.add(spans(1, 0, 5), 'b.json');
    await r.flush();
    await r.close();
    const next = state(w, 0);
    expect(next.checkpoint).toBe(3);
    expect(next.flushPartitions).toEqual([1]);
  });

  test('append with an added statistics key marks older partitions unknown for it', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.close();
    const a = await open(w, cfg({ statisticsKeys: ['resource:deployment.environment'] }), 'append');
    await a.add(spans(1, 0, 5), 'b.json');
    await a.close();
    const m = manifest(w);
    const key = 'resource:deployment.environment';
    expect(m.statisticsKeys.spans).toContain(key);
    expect(m.partitions[0]?.files.spans?.values[key]).toBeNull();
    expect(m.partitions[1]?.files.spans?.values[key]).toEqual([]);
    expect(Reflect.get(m.partitions[0]?.files.spans?.values ?? {}, 'service_name')).toEqual(['svc']);
  });

  test('a malformed state is refused before any write', async () => {
    const w = createTestWriter();
    const bad = { formatVersion: 2, nextPartition: -1 } as unknown as SessionStateV2;
    await expect(writeStateSlotV2(w.fs, OUT, 0, bad)).rejects.toThrow();
    expect([...w.fs.snapshot().keys()]).toEqual([]);
  });
});

describe('format mismatches', () => {
  const chunkReport = (w: TestWriter): Promise<void> => copyFrozenReport(w, OUT);

  test('open on a format-3 report with format site fails version-mismatch: use merge to convert', async () => {
    const w = createTestWriter();
    await chunkReport(w);
    const e = await failure(open(w, cfg(), 'open'));
    expect(e.code).toBe('version-mismatch');
    expect(e.hint).toContain('use merge to convert');
    expect(w.fs.snapshot().has(`${OUT}/${LOCK_PATH}`)).toBe(false);
  });

  test('append on a format-3 report fails the same way', async () => {
    const w = createTestWriter();
    await chunkReport(w);
    expect((await failure(open(w, cfg(), 'append'))).code).toBe('version-mismatch');
  });

  test('opening a format-4 report as the other format fails and names writer.format local or site', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.close();
    const e = await failure(open(w, cfg({ format: 'local' }), 'open'));
    expect(e.code).toBe('usage');
    expect(e.hint).toContain('--format site');
    expect(e.hint).not.toContain('--assets-base');
  });

  test('the hint on a shared-base report offers upgrade', async () => {
    const w = createTestWriter();
    const s = await open(w, cfg({ assetsBase: '../../assets/0.3.0/' }));
    await s.add(spans(1), 'a.json');
    await s.close();
    const e = await failure(open(w, cfg({ format: 'local' }), 'open'));
    expect(e.hint).toContain('--format site');
    expect(e.hint).toContain('upgrade');
  });

  test('replacing a format-4 report as the other format removes its partitions', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(2), 'a.json');
    await s.close();
    expect(await w.fs.exists(`${OUT}/data/partitions/000000/spans.parquet`)).toBe(true);
    const r = await open(w, cfg({ format: 'local' }), 'replace');
    await r.add(spans(1, 0, 7), 'b.json');
    await r.close();
    expect(manifest(w).engine.format).toBe('local');
    expect(manifest(w).totals.spans).toBe(1);
    expect(manifest(w).partitions).toHaveLength(1);
  });

  test('format local is recorded in manifest.engine', async () => {
    const w = createTestWriter();
    const s = await open(w, cfg({ format: 'local' }));
    await s.add(spans(1), 'a.json');
    await s.flush();
    expect(manifest(w).engine).toEqual({ version: '1.32.0', format: 'local', assetsBase: 'assets/' });
    await s.close();
  });

  test('replace over a format-3 report starts a format-4 one', async () => {
    const w = createTestWriter();
    await chunkReport(w);
    const s = await open(w);
    await s.add(spans(1, 0, 2), 'a.json');
    await s.close();
    expect(manifest(w).formatVersion).toBe(4);
    expect([...w.fs.snapshot().keys()].some((k) => k.includes('data/chunks/spans/0'))).toBe(false);
  });
});

describe('trace summaries per partition', () => {
  async function traceIds(w: TestWriter, n: number): Promise<string[]> {
    const bytes = await w.fs.readBytes(`${OUT}/data/partitions/${String(n).padStart(6, '0')}/traces.parquet`);
    return decodeTable('traces', bytes).map((r) => String(Reflect.get(r, 'trace_id')));
  }

  test('a partition with spans and logs lists a traces file with one row per distinct trace', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(2), 'a.json');
    await s.add(
      otlp(
        logsRequest([
          logRecord({ traceId: traceIdOf(0) }),
          logRecord({ traceId: traceIdOf(7) }),
          logRecord(),
        ]),
      ),
      'l.json',
    );
    await s.flush();
    const file = manifest(w).partitions[0]?.files.traces;
    expect(file?.path).toBe('data/partitions/000000/traces.parquet');
    expect(file?.rows).toBe(3);
    expect((await traceIds(w, 0)).sort()).toEqual([traceIdOf(0), traceIdOf(1), traceIdOf(7)].sort());
    await s.close();
  });

  test('the same trace in the next flush is a second row in the next partition', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.flush();
    await s.add(otlp(logsRequest([logRecord({ traceId: traceIdOf(0) })])), 'l.json');
    await s.flush();
    expect(await traceIds(w, 0)).toEqual([traceIdOf(0)]);
    expect(await traceIds(w, 1)).toEqual([traceIdOf(0)]);
    await s.close();
  });

  test('a cut that fails and then succeeds writes one traces row per trace', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(2), 'a.json');
    w.fs.failNextWrite('000000/spans.parquet');
    await expect(s.flush()).rejects.toThrow();
    await s.flush();
    expect(manifest(w).partitions[0]?.files.traces?.rows).toBe(2);
    expect(await traceIds(w, 0)).toHaveLength(2);
    await s.close();
  });

  test('a logs-only trace without log times writes null times and leaves the file range to the others', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.add(
      otlp(logsRequest([logRecord({ traceId: traceIdOf(9), timeUnixNano: '0', observedTimeUnixNano: '0' })])),
      'l.json',
    );
    await s.flush();
    const bytes = await w.fs.readBytes(`${OUT}/data/partitions/000000/traces.parquet`);
    const rows = decodeTable('traces', bytes);
    const timeless = rows.find((r) => Reflect.get(r, 'trace_id') === traceIdOf(9));
    expect(Reflect.get(timeless ?? {}, 'start_time_unix_nano')).toBeNull();
    const file = manifest(w).partitions[0]?.files.traces;
    const real = rows.find((r) => Reflect.get(r, 'trace_id') === traceIdOf(0));
    expect(file?.timeMin).toBe(String(Reflect.get(real ?? {}, 'start_time_unix_nano')));
    expect(file?.timeMax).toBe(String(Reflect.get(real ?? {}, 'start_time_unix_nano')));
    await s.close();
  });
});

const counter = (value: number, t: number) =>
  otlp(
    metricsRequest([
      {
        name: 'c',
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: [
            {
              asInt: String(value),
              startTimeUnixNano: EPOCH_NS,
              timeUnixNano: (BigInt(EPOCH_NS) + BigInt(t) * 1_000_000_000n).toString(),
            },
          ],
        },
      } as never,
    ]),
  );

describe('close compacts the flush partitions', () => {
  const partitionDirs = (w: TestWriter): string[] => [
    ...new Set([...w.fs.snapshot().keys()].flatMap((p) => p.match(/data\/partitions\/(\d{6})\//)?.[1] ?? [])),
  ];

  async function flushed(s: WriterSession, batches: number): Promise<void> {
    for (let i = 0; i < batches; i++) {
      await s.add(spans(2, 0, i * 10), `s${i}.json`);
      await s.add(logs(3), `l${i}.json`);
      await s.add(counter(10 * (i + 1), i + 1), `m${i}.json`);
      await s.flush();
    }
  }

  test('three flushes become one partition after them, holding every row, and the old folders are gone', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await flushed(s, 3);
    expect(partitionDirs(w)).toEqual(['000000', '000001', '000002']);
    await s.close();
    const m = manifest(w);
    expect(m.complete).toBe(true);
    expect(m.partitions.map((p) => [p.n, p.source])).toEqual([[3, 'compact:0..2']]);
    expect(partitionDirs(w)).toEqual(['000003']);
    expect(m.partitions[0]?.files.spans?.rows).toBe(6);
    expect(m.partitions[0]?.files.logs?.rows).toBe(9);
    expect(m.partitions[0]?.files.traces?.rows).toBeGreaterThan(0);
    const ids = (await spanIds(w, 3)).sort();
    expect(ids).toEqual([0, 1, 10, 11, 20, 21].map((i) => spanIdOf(i)).sort());
    const slots = ([0, 1] as const).map((i) => state(w, i));
    expect(slots.some((st) => st.nextPartition === 4 && st.flushPartitions.length === 0)).toBe(true);
    expect(m.totals).toMatchObject({ spans: 6, logs: 9 });
  });

  test('the compacted rows are in the table sort order', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1, 0, 20), 'a.json');
    await s.flush();
    await s.add(spans(1, 0, 0), 'b.json');
    await s.flush();
    await s.close();
    const rows = decodeTable('spans', await w.fs.readBytes(`${OUT}/data/partitions/000002/spans.parquet`));
    const starts = rows.map((r) => Reflect.get(r, 'start_time_unix_nano') as bigint);
    expect(starts).toEqual([...starts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  test('one flush partition is left as it is', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(2), 'a.json');
    await s.close();
    const m = manifest(w);
    expect(m.partitions.map((p) => [p.n, p.source])).toEqual([[0, 'flush:0']]);
    expect(partitionDirs(w)).toEqual(['000000']);
  });

  test('a partition copied by merge is never compacted with the flush partitions', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(2), 'a.json');
    await s.close();
    const copied = manifest(w);
    const [first] = copied.partitions;
    if (first === undefined) throw new Error('no partition');
    await writeManifest(w.fs, OUT, { ...copied, partitions: [{ ...first, source: 'merge:other' }] });
    const a = await open(w, cfg(), 'append');
    await flushed(a, 2);
    await a.close();
    const m = manifest(w);
    expect(m.partitions.map((p) => [p.n, p.source])).toEqual([
      [0, 'merge:other'],
      [3, 'compact:1..2'],
    ]);
    expect(partitionDirs(w)).toEqual(['000000', '000003']);
  });

  test('the state written at close is the state before it, apart from the partition numbering', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await flushed(s, 3);
    const before = ([0, 1] as const).map((i) => state(w, i)).sort((a, b) => b.checkpoint - a.checkpoint)[0];
    await s.close();
    const after = ([0, 1] as const).map((i) => state(w, i)).sort((a, b) => b.checkpoint - a.checkpoint)[0];
    if (before === undefined || after === undefined) throw new Error('no state');
    expect(after.checkpoint).toBeGreaterThan(before.checkpoint);
    expect(before.dedupe.length).toBeGreaterThan(0);
    expect(JSON.stringify(before.metricStreams).length).toBeGreaterThan(10);
    expect(JSON.stringify(before.drain).length).toBeGreaterThan(10);
    const { checkpoint: _c, nextPartition: _n, flushPartitions: _f, ...rest } = after;
    const { checkpoint: _c2, nextPartition: _n2, flushPartitions: _f2, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(after).toMatchObject({ nextPartition: 4, flushPartitions: [] });
  });

  test('once close has released the state, add, flush and endInput reject, and a retried close completes', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await flushed(s, 3);
    w.fs.failNextWrite('data/manifest.js');
    await expect(s.close()).rejects.toThrow();
    for (const call of [
      () => s.add(spans(1, 0, 90), 'x.json'),
      () => s.add(logs(1), 'y.json'),
      () => s.flush(),
      () => s.endInput(),
    ]) {
      await expect(call()).rejects.toThrow(`session for ${OUT} is closing`);
    }
    const summary = await s.close();
    expect(summary).toBeDefined();
    const m = manifest(w);
    expect(m.complete).toBe(true);
    expect(m.partitions.map((p) => [p.n, p.source])).toEqual([[3, 'compact:0..2']]);
    expect(Number(m.epochUnixNano)).toBe(Number(EPOCH_NS));
    // The replaced flush folders go in the same session, though the first close lost its list of them.
    expect(partitionDirs(w)).toEqual(['000003']);
  });

  test('a close after an abort rejects and writes nothing, even when the first close failed past the release', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await flushed(s, 3);
    w.fs.failNextWrite('data/manifest.js');
    await expect(s.close()).rejects.toThrow();
    await s.abort();
    const a = await open(w, cfg(), 'append');
    const before = w.fs.snapshot();
    await expect(s.close()).rejects.toThrow(`session for ${OUT} is closed`);
    expect(w.fs.snapshot()).toEqual(before);
    await a.abort();
  });

  test('the manifest lists partitions in ascending n even when a copied one lies between the compacted ones', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await flushed(s, 3);
    await s.abort();
    const left = manifest(w);
    const partitions = left.partitions.map((p) => (p.n === 1 ? { ...p, source: 'merge:other' } : p));
    await writeManifest(w.fs, OUT, { ...left, partitions });
    const a = await open(w, cfg(), 'append');
    await a.close();
    const m = manifest(w);
    expect(m.partitions.map((p) => [p.n, p.source])).toEqual([
      [1, 'merge:other'],
      [3, 'compact:0..2'],
    ]);
  });

  test('a compaction that fails midway through reading keeps every flush partition and deletes none', async () => {
    const w = createTestWriter();
    const s = await open(w);
    // Two files larger than one read batch (32768 rows) and than one merge chunk, so rows are written before the fault.
    for (let i = 0; i < 2; i++) {
      await s.add(logs(33_000), `l${i}.json`);
      await s.flush();
    }
    let calls = 0;
    columnsFault.fail = () => ++calls === 3; // the second batch of the first input, mid-merge
    try {
      await s.close();
    } finally {
      columnsFault.fail = () => false;
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    const m = manifest(w);
    expect(m.complete).toBe(true);
    expect(m.partitions.map((p) => p.source)).toEqual(['flush:0', 'flush:1']);
    expect(partitionDirs(w)).toEqual(['000000', '000001']);
    // The log names the read fault itself: a truncated file would only have been caught later, by the row count.
    const failed = w.logs.find((l) => l.level === 'error' && l.msg.includes('compaction failed'));
    expect(String(Reflect.get(failed?.attrs ?? {}, 'error'))).toContain('injected read fault');
  }, 60_000);

  test('a compaction that fails keeps the flush partitions, closes the report and removes what it wrote', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await flushed(s, 2);
    w.fs.failNextWrite('data/partitions/000002/logs.parquet');
    await s.close();
    const m = manifest(w);
    expect(m.complete).toBe(true);
    expect(m.partitions.map((p) => p.source)).toEqual(['flush:0', 'flush:1']);
    expect(partitionDirs(w)).toEqual(['000000', '000001']);
    expect(w.logs.some((l) => l.level === 'error' && l.msg.includes('compaction failed'))).toBe(true);
    expect(await w.fs.exists(`${OUT}/${LOCK_PATH}`)).toBe(false);
  });
});

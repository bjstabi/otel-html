import { describe, expect, test, vi } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { LOCK_PATH, MANIFEST_KEY } from '../../src/format/paths.js';
import { parseAnySessionState, type SessionStateV2 } from '../../src/format/state.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { writeStateSlotV2 } from '../../src/writer/checkpoint.js';
import { openSession, type WriterSession } from '../../src/writer/session.js';
import { logRecord, logsRequest, span, traceRequest } from '../../test-support/otlp-builders.js';
import {
  createTestWriter,
  EPOCH_NS,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';
import { spanIdOf, spansRequest } from './helpers.js';

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
    expect(Object.keys(entry?.files ?? {})).toEqual(['spans']);
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

  test('metrics are rejected and merge input is not supported yet', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const metrics = otlp({ resourceMetrics: [] });
    const e = await failure(s.add(metrics, 'm.json'));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('metrics are not written in format 4 yet');
    const r = await failure(
      s.addRecords({ signal: 'spans', rows: [], resources: [], scopes: [], epoch: 0n as never }),
    );
    expect(r.code).toBe('usage');
    expect(r.message).toContain('not supported yet');
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
  async function chunkReport(w: TestWriter): Promise<void> {
    const s = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
    await s.add(otlp(spansRequest(1)), 'a.json');
    await s.close();
  }

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

  test('the chunk session opening a format-4 report fails and names writer.format local or site', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(1), 'a.json');
    await s.close();
    const e = await failure(
      openSession(w.deps, { out: OUT, config: testConfig(), mode: 'open' }) as Promise<WriterSession>,
    );
    expect(e.code).toBe('version-mismatch');
    expect(e.hint).toContain('writer.format');
    expect(e.hint).toContain('local or site');
  });

  test('the chunk session replacing a format-4 report removes its partitions', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(spans(2), 'a.json');
    await s.close();
    expect(await w.fs.exists(`${OUT}/data/partitions/000000/spans.parquet`)).toBe(true);
    const r = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
    await r.add(spans(1, 0, 7), 'b.json');
    await r.close();
    expect([...w.fs.snapshot().keys()].some((k) => k.includes('data/partitions'))).toBe(false);
    expect(
      parseAnyManifest(
        reviveDataJson(unwrapDataFile(w.fs.snapshot().get(`${OUT}/data/manifest.js`) ?? '', MANIFEST_KEY)),
      ).formatVersion,
    ).toBe(3);
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

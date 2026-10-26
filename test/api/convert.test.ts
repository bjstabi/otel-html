import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { convert } from '../../src/api/convert.js';
import { merge } from '../../src/api/index.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportLogsServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import { logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, type TestWriter } from '../../test-support/writer-deps.js';
import { allSpans, manifestOf, spansRequest } from '../writer/helpers.js';

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

const enc = new TextEncoder();
async function put(w: TestWriter, path: string, text: string | Uint8Array): Promise<void> {
  await w.fs.writeBytes(path, typeof text === 'string' ? enc.encode(text) : text);
}

describe('convert', () => {
  test('no input files is a usage error', async () => {
    const w = createTestWriter();
    const e = await failure(convert({ input: [], out: 'r' }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('no input files');
    expect(await w.fs.exists('r')).toBe(false);
  });

  test('a logs-only file succeeds with no spans', async () => {
    const w = createTestWriter();
    await put(w, 'in/logs.otlp.json', JSON.stringify(logsRequest([logRecord(), logRecord()])));
    const summary = await convert({ input: 'in/logs.otlp.json', out: 'r' }, w.deps);
    expect(summary.totals).toEqual({ spans: 0, logs: 2, metrics: 0 });
    expect(manifestOf(w, 'r').complete).toBe(true);
  });

  test('combines JSON, JSON lines and protobuf inputs in order', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    await put(
      w,
      'in/b.jsonl',
      `${JSON.stringify(spansRequest(1, 0, 10))}\n${JSON.stringify(spansRequest(1, 0, 11))}\n`,
    );
    const bin = toBinary(
      ExportLogsServiceRequestSchema,
      create(ExportLogsServiceRequestSchema, {
        resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: 1700000000000000001n }] }] }],
      }),
    );
    await put(w, 'in/c.pb', bin);
    const summary = await convert(
      { input: ['in/a.json', 'in/b.jsonl', 'in/c.pb'], out: 'r', signal: 'logs' },
      w.deps,
    );
    expect(summary.totals).toEqual({ spans: 4, logs: 1, metrics: 0 });
  });

  test('protobuf without a signal hint is a usage error naming the file', async () => {
    const w = createTestWriter();
    await put(w, 'in/c.pb', new Uint8Array([]));
    const e = await failure(convert({ input: 'in/c.pb', out: 'r' }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('in/c.pb');
  });

  test('a missing input file is a usage error naming it', async () => {
    const w = createTestWriter();
    const e = await failure(convert({ input: ['in/missing.json'], out: 'r' }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('in/missing.json');
  });

  test('invalid OTLP names the file and leaves a lock-free folder', async () => {
    const w = createTestWriter();
    await put(w, 'in/bad.json', '{"resourceSpans": 3}');
    const e = await failure(convert({ input: 'in/bad.json', out: 'r' }, w.deps));
    expect(e.code).toBe('invalid-otlp');
    expect(e.message).toContain('in/bad.json');
    await put(w, 'in/ok.json', JSON.stringify(spansRequest(1)));
    await convert({ input: 'in/ok.json', out: 'r' }, w.deps);
  });
});

describe('convert of an empty request', () => {
  test('{"resourceSpans":[]} produces a valid, empty report', async () => {
    const w = createTestWriter();
    await put(w, 'in/empty.json', '{"resourceSpans":[]}');
    const summary = await convert({ input: 'in/empty.json', out: 'r' }, w.deps);
    expect(summary.totals).toEqual({ spans: 0, logs: 0, metrics: 0 });
    const m = manifestOf(w, 'r');
    expect(m.complete).toBe(true);
    expect(m.chunks).toEqual([]);
    expect(await w.fs.exists('r/index.html')).toBe(true);
  });
});

describe('merge (public)', () => {
  test('merges converted reports', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    await put(w, 'in/b.json', JSON.stringify(spansRequest(2, 1000, 5)));
    await convert({ input: 'in/a.json', out: 'a' }, w.deps);
    await convert({ input: 'in/b.json', out: 'b' }, w.deps);
    const summary = await merge({ inputs: ['a', 'b'], out: 'm', config: { title: 'merged' } }, w.deps);
    expect(summary.totals.spans).toBe(4);
    expect(manifestOf(w, 'm').title).toBe('merged');
  });

  describe('a failed convert leaves the existing report in place', () => {
    async function existing(w: TestWriter): Promise<void> {
      await put(w, 'in/good.json', JSON.stringify(spansRequest(3)));
      await convert({ input: 'in/good.json', out: 'r' }, w.deps);
    }

    test('a missing input file', async () => {
      const w = createTestWriter();
      await existing(w);
      const before = w.fs.snapshot();
      const e = await failure(convert({ input: 'in/typo.json', out: 'r' }, w.deps));
      expect(e.code).toBe('usage');
      expect(manifestOf(w, 'r').totals.spans).toBe(3);
      expect(allSpans(w, 'r')).toHaveLength(3);
      // Only the writer's lock file may differ.
      const after = w.fs.snapshot();
      for (const [path, text] of before) {
        if (!path.endsWith('.lock')) expect(after.get(path), path).toBe(text);
      }
    });

    test('a malformed input file after a readable one', async () => {
      const w = createTestWriter();
      await existing(w);
      await put(w, 'in/other.json', JSON.stringify(spansRequest(2, 0, 50)));
      await put(w, 'in/bad.json', '{ not json');
      await failure(convert({ input: ['in/other.json', 'in/bad.json'], out: 'r' }, w.deps));
      expect(manifestOf(w, 'r').totals.spans).toBe(3);
      expect(allSpans(w, 'r')).toHaveLength(3);
    });
  });
});

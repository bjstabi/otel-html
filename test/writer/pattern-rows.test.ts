import { describe, expect, test } from 'vitest';
import { batchFromRows } from '../../src/format/parquet/batch.js';
import type { Row } from '../../src/format/parquet/rows.js';
import { cutSample, Drain, template } from '../../src/rollups/drain.js';
import { severityKey } from '../../src/semconv/severity.js';
import { patternRows as patternRowsOf } from '../../src/writer/pattern-rows.js';

const log = (text: string, extra: Row = {}): Row => ({
  body: JSON.stringify(text),
  severity_number: 9n,
  ...extra,
});
const patternRows = (drain: Drain, logs: readonly Row[], epoch: bigint) =>
  patternRowsOf(drain, batchFromRows('logs', logs), epoch);
const cell = (r: Row, k: string): unknown => Reflect.get(r, k);

describe('patternRows', () => {
  test('the sample of a long body is cut like the Drain cuts it', () => {
    const long = `start ${'x'.repeat(1000)}`;
    const { rows } = patternRows(new Drain(), [log(long, { time_unix_nano: 5n })], 0n);
    expect(cell(rows[0] ?? {}, 'sample')).toBe(cutSample(long));
    expect(String(cell(rows[0] ?? {}, 'sample')).length).toBeLessThanOrEqual(256);
  });

  test('a cut without logs returns the same Drain and no rows', () => {
    const d = new Drain();
    d.add('hello 1', severityKey(9), 0 as never);
    const before = JSON.stringify(d.toJSON());
    const r = patternRows(d, [], 0n);
    expect(r.rows).toEqual([]);
    expect(r.drain).toBe(d);
    expect(JSON.stringify(d.toJSON())).toBe(before);
  });

  test('first and last use the observed time when there is no time, and skip logs with neither', () => {
    const { rows } = patternRows(
      new Drain(),
      [
        log('user 1 in', { time_unix_nano: 100n }),
        log('user 2 in', { observed_time_unix_nano: 300n }),
        log('user 3 in'),
        log('user 4 in', { time_unix_nano: 200n, observed_time_unix_nano: 900n }),
      ],
      0n,
    );
    expect(rows).toHaveLength(1);
    expect(cell(rows[0] ?? {}, 'count')).toBe(4n);
    expect(cell(rows[0] ?? {}, 'first_time_unix_nano')).toBe(100n);
    expect(cell(rows[0] ?? {}, 'last_time_unix_nano')).toBe(300n);
  });

  test('a cluster whose logs have no time has null first and last', () => {
    const { rows } = patternRows(new Drain(), [log('user 1 in'), log('user 2 in')], 0n);
    expect(cell(rows[0] ?? {}, 'first_time_unix_nano')).toBeNull();
    expect(cell(rows[0] ?? {}, 'last_time_unix_nano')).toBeNull();
  });

  test('clustering over three cuts equals one Drain fed the same bodies', () => {
    const bodies = [
      'user 1 logged in',
      'disk full on sda',
      'user 2 logged in',
      'GET /a 200 12ms',
      'user 3 logged in',
      'GET /b 404 3ms',
      'disk full on sdb',
      'cache miss for key abc',
      'cache miss for key def',
    ];
    const cuts = [bodies.slice(0, 2), bodies.slice(2, 6), bodies.slice(6)];
    let drain = new Drain();
    const counts = new Map<bigint, bigint>();
    for (const cut of cuts) {
      const r = patternRows(
        drain,
        cut.map((b) => log(b)),
        0n,
      );
      drain = r.drain;
      for (const row of r.rows) {
        const id = cell(row, 'cluster_id') as bigint;
        counts.set(id, (counts.get(id) ?? 0n) + (cell(row, 'count') as bigint));
      }
    }
    const direct = new Drain();
    const directCounts = new Map<bigint, bigint>();
    for (const b of bodies) {
      const id = BigInt(direct.add(b, severityKey(9), 0 as never));
      directCounts.set(id, (directCounts.get(id) ?? 0n) + 1n);
    }
    const tpl = (d: Drain) => d.clusters().map((c) => template(c));
    expect(tpl(drain)).toEqual(tpl(direct));
    expect(counts).toEqual(directCounts);
  });
});

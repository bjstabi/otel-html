import { describe, expect, test } from 'vitest';
import { buildFormat4Report, openFixtureDb } from '../../test-support/format4-fixture.js';
import {
  attr,
  expHistogram,
  gauge,
  histogram,
  metricsRequest,
  pointsAt,
  sum,
  summary,
} from '../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../test-support/writer-deps.js';

const t = (ms: number): string => String(BigInt(EPOCH_NS) + BigInt(ms) * 1_000_000n);

describe('metric builders', () => {
  test('every point kind round-trips through the format-4 writer', async () => {
    const times = [1000, 2000];
    const request = metricsRequest(
      [
        gauge(
          'g',
          pointsAt(times, (i) => ({ asDouble: i })),
        ),
        sum(
          's',
          pointsAt(times, (i) => ({ asInt: String(i) })),
          { monotonic: true, temporality: 'cumulative', unit: 'By' },
        ),
        histogram(
          'h',
          pointsAt(times, () => ({
            explicitBounds: [1, 5],
            bucketCounts: ['1', '2', '3'],
            count: '6',
            sum: 12,
            min: 0.5,
            max: 9,
          })),
          { temporality: 'delta' },
        ),
        expHistogram(
          'e',
          pointsAt(times, () => ({
            scale: 0,
            zeroCount: '1',
            count: '4',
            sum: 5,
            positive: { offset: 0, bucketCounts: ['1', '2'] },
            negative: { offset: 0, bucketCounts: ['0'] },
          })),
          { temporality: 'cumulative' },
        ),
        summary(
          'q',
          pointsAt(times, () => ({
            count: '3',
            sum: 6,
            quantileValues: [{ quantile: 0.5, value: 2 }],
          })),
        ),
      ],
      [attr('service.name', { stringValue: 'svc' })],
    );
    const f = await buildFormat4Report([otlp(request as never)]);
    expect(f.manifest.totals.metrics).toBe(10);
    const db = await openFixtureDb(f);
    try {
      const rows = db.rows(
        `SELECT metric_name, point_type, count(*) AS n FROM points GROUP BY ALL ORDER BY metric_name`,
      );
      const typed = rows as { metric_name: string; point_type: string; n: bigint }[];
      expect(typed.map((r) => [r.metric_name, r.point_type, Number(r.n)])).toEqual([
        ['e', 'exp_histogram', 2],
        ['g', 'gauge', 2],
        ['h', 'histogram', 2],
        ['q', 'summary', 2],
        ['s', 'sum', 2],
      ]);
    } finally {
      db.close();
    }
  });

  test('pointsAt stamps times and attributes', () => {
    const pts = pointsAt([5], () => ({ asDouble: 1 }), [attr('k', { stringValue: 'v' })]);
    expect(pts).toEqual([
      { timeUnixNano: t(5), asDouble: 1, attributes: [{ key: 'k', value: { stringValue: 'v' } }] },
    ]);
  });
});

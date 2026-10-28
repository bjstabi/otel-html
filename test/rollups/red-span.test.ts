import { describe, expect, it } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { SpanKind, StatusCode } from '../../src/model/records.js';
import { LogRollups } from '../../src/rollups/log-rollups.js';
import { MetricCatalog } from '../../src/rollups/metric-catalog.js';
import { RedSeries } from '../../src/rollups/red.js';
import { createRollups, deserializeRollups, serializeRollups } from '../../src/rollups/report-rollups.js';
import { METRIC_KEYS, SignalCounts } from '../../src/rollups/signal-counts.js';
import { DEFAULT_SPAN_FACETS, SpanRollups } from '../../src/rollups/span-rollups.js';
import { severityKey } from '../../src/semconv/severity.js';
import { logTarget, spanTarget } from '../ottl/fixtures.js';

const t = (n: number): RelNanos => n as RelNanos;
const opts = { facetValueCap: 4, facetKeyCap: 50 };

describe('RedSeries', () => {
  it('conserves counts and errors across coarsening', () => {
    const r = new RedSeries(32);
    let errors = 0;
    for (let i = 0; i < 3000; i++) {
      const err = i % 7 === 0;
      if (err) errors++;
      r.add(t(i * 3_000_000), (i % 50) * 1_000_000 + 1, err);
    }
    const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
    expect(sum(r.counts)).toBe(3000);
    expect(sum(r.errors)).toBe(errors);
    expect(r.histograms.reduce((s, h) => s + (h?.count ?? 0), 0)).toBe(3000);
    r.histograms.forEach((h, i) => {
      expect(h?.count ?? 0).toBe(r.counts[i]);
    });
  });
  it('round-trips', () => {
    const r = new RedSeries(16);
    for (let i = 0; i < 200; i++) r.add(t(i * 9_000_000), i + 1, i % 5 === 0);
    expect(RedSeries.from(JSON.parse(JSON.stringify(r.toJSON()))).toJSON()).toEqual(r.toJSON());
  });
});

describe('SignalCounts', () => {
  it('maps severity numbers to ranges', () => {
    expect(severityKey(0)).toBe('unspecified');
    expect(severityKey(1)).toBe('trace');
    expect(severityKey(9)).toBe('info');
    expect(severityKey(17)).toBe('error');
    expect(severityKey(24)).toBe('fatal');
    expect(() => severityKey(25)).toThrow(/severity/);
  });
  it('counts and round-trips', () => {
    const c = new SignalCounts(['a', 'b']);
    c.add(t(1), 'a');
    c.add(t(5_000_000), 'b', 2);
    expect(c.total('b')).toBe(2);
    expect(SignalCounts.from(JSON.parse(JSON.stringify(c.toJSON())), ['a', 'b']).toJSON()).toEqual(
      c.toJSON(),
    );
  });
});

describe('SpanRollups', () => {
  it('has the documented core facets', () => {
    expect(DEFAULT_SPAN_FACETS.map((f) => f.key)).toEqual([
      'service.name',
      'span.name',
      'span.kind',
      'status.code',
      'resource',
      'instrumentation_scope.name',
      'host.name',
      'deployment.environment.name',
    ]);
  });
  it('rolls up buckets, facets, durations and RED', () => {
    const s = new SpanRollups(opts);
    s.add(spanTarget());
    s.add(spanTarget({ status: { code: StatusCode.OK, message: '' }, kind: SpanKind.CLIENT }));
    expect(s.buckets.counts('error')[0]).toBe(1);
    expect(s.buckets.counts('ok')[0]).toBe(1);
    expect(s.facets.top('service.name', 5)).toEqual([{ value: 'checkout', count: 2 }]);
    expect(s.facets.top('span.kind', 5).map((x) => x.value)).toEqual(['client', 'server']);
    expect(s.facets.top('http.route', 5)).toEqual([{ value: '/api/cart', count: 2 }]);
    expect(s.facets.top('http.response.status_code', 5)).toEqual([{ value: '503', count: 2 }]);
    expect(s.facets.keys()).not.toContain('nested');
    const h = s.durations.get('checkout\u0000GET /api/cart');
    expect(h?.count).toBe(2);
    expect(s.red.counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(s.red.errors.reduce((a, b) => a + b, 0)).toBe(1);
  });
  it('is deterministic and round-trips via serializeRollups', () => {
    const mk = (): SpanRollups => {
      const s = new SpanRollups(opts);
      for (let i = 0; i < 20; i++)
        s.add(spanTarget({ start: t(i * 2_000_000), end: t(i * 2_000_000 + 5000 + i) }));
      return s;
    };
    expect(mk().toJSON()).toEqual(mk().toJSON());
    const logs = new LogRollups(opts);
    logs.add(logTarget({ time: t(3_000_000) }));
    const rollups = {
      spans: mk(),
      logs,
      metrics: { buckets: new SignalCounts(METRIC_KEYS), catalog: new MetricCatalog({ seriesCap: 10 }) },
    };
    const ser = serializeRollups(rollups);
    const back = deserializeRollups(JSON.parse(JSON.stringify(ser)), { ...opts, metricSeriesCap: 10 });
    expect(serializeRollups(back)).toEqual(ser);
  });
  it('fails fast on malformed rollups', () => {
    expect(() =>
      deserializeRollups({ spans: 1, logs: {}, metrics: {} }, { ...opts, metricSeriesCap: 10 }),
    ).toThrow(/rollups.spans/);
    const ok = serializeRollups(createRollups({ ...opts, metricSeriesCap: 10 }));
    const bad = { ...ok, metrics: { buckets: new SignalCounts(METRIC_KEYS).toJSON(), catalog: { x: 1 } } };
    expect(() => deserializeRollups(bad, { ...opts, metricSeriesCap: 10 })).toThrow(
      /rollups\.metrics\.catalog/,
    );
    expect(() => deserializeRollups({}, { ...opts, metricSeriesCap: 10 })).toThrow(/spans/);
  });
});

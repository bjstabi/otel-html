import { describe, expect, it } from 'vitest';
import type { AnyValue } from '../../src/model/anyvalue.js';
import type { RelNanos } from '../../src/model/ids.js';
import type {
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../src/model/records.js';
import type { BucketAgg } from '../../src/rollups/metric-agg.js';
import { MetricCatalog } from '../../src/rollups/metric-catalog.js';
import type { Normalized } from '../../src/rollups/metric-streams.js';

const rel = (n: number): RelNanos => n as RelNanos;
const MS = 1_000_000;

function pt(o: Partial<MetricPointRecord> = {}): MetricPointRecord {
  return {
    name: 'm',
    description: 'd',
    unit: 's',
    type: 'gauge',
    temporality: 'unspecified',
    monotonic: false,
    start: null,
    time: rel(1),
    attributes: new Map(),
    flags: 0,
    point: { asDouble: 1 },
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
    ...o,
  };
}
const attrs = (o: Record<string, AnyValue>): Map<string, AnyValue> => new Map(Object.entries(o));
const res = (name: string): ResourceRecord => ({
  attributes: attrs({ 'service.name': { kind: 'string', value: name } }),
  droppedAttributesCount: 0,
  schemaUrl: '',
});
const scope: ScopeRecord = {
  name: 'lib',
  version: '1',
  attributes: new Map(),
  droppedAttributesCount: 0,
  schemaUrl: '',
};
const histPt = (bounds: number[]): MetricPointRecord =>
  pt({
    type: 'histogram',
    temporality: 'delta',
    point: { count: '1', bucketCounts: ['1', '0'], explicitBounds: bounds },
  });

describe('MetricCatalog definitions', () => {
  it('interns by (name, unit, type, temporality, monotonic)', () => {
    const c = new MetricCatalog({ seriesCap: 10 });
    expect(c.defOf(pt()).id).toBe(c.defOf(pt({ description: 'other text' })).id);
    expect(c.entries()).toHaveLength(1);
  });

  it('marks every definition of a name conflicting when units differ', () => {
    const c = new MetricCatalog({ seriesCap: 10 });
    c.defOf(pt({ name: 'solo' }));
    const a = c.defOf(pt({ unit: 's' }));
    const b = c.defOf(pt({ unit: 'ms' }));
    expect(a.id).not.toBe(b.id);
    const e = c.entries();
    expect(e.filter((x) => x.name === 'm').every((x) => x.conflicting)).toBe(true);
    expect(e.find((x) => x.name === 'solo')?.conflicting).toBe(false);
  });
});

describe('MetricCatalog series', () => {
  it('folds series beyond the cap into one other series', () => {
    const c = new MetricCatalog({ seriesCap: 1000 });
    const p0 = pt();
    const def = c.defOf(p0);
    const r = res('a');
    let news = 0;
    for (let i = 0; i < 1500; i++) {
      const p = pt({ attributes: attrs({ k: { kind: 'int', value: BigInt(i) } }) });
      if (c.seriesOf(def, p, r, scope).isNew) news++;
    }
    const entry = c.entries()[0];
    expect(entry?.series).toBe(1001);
    expect(entry?.folded).toBe(500);
    expect(news).toBe(1001);
    const defs = c.seriesDefs(def.id);
    const last = defs[defs.length - 1];
    expect(last).toMatchObject({ other: true, resource: -1, scope: -1, attributes: new Map(), id: 1000 });
    // An existing series still resolves after the cap.
    const again = c.seriesOf(def, pt({ attributes: attrs({ k: { kind: 'int', value: 3n } }) }), r, scope);
    expect(again.isNew).toBe(false);
    expect(again.series.other).toBe(false);
    expect(c.entries()[0]?.folded).toBe(500);
  });

  it('separates series by explicit bounds, resource, scope and attributes', () => {
    const c = new MetricCatalog({ seriesCap: 10 });
    const d = c.defOf(histPt([1]));
    const a = c.seriesOf(d, histPt([1]), res('a'), scope);
    const b = c.seriesOf(d, histPt([2]), res('a'), scope);
    const r2 = c.seriesOf(d, histPt([1]), res('b'), scope);
    const same = c.seriesOf(d, histPt([1]), res('a'), { ...scope });
    expect(new Set([a.series.id, b.series.id, r2.series.id]).size).toBe(3);
    expect(same.series.id).toBe(a.series.id);
    expect(a.series.bounds).toEqual([1]);
    expect(c.resources()).toHaveLength(2);
    expect(c.scopes()).toHaveLength(1);
    expect(c.entries()[0]?.resources).toEqual([0, 1]);
  });

  it('tracks dirty metrics when series are added', () => {
    const c = new MetricCatalog({ seriesCap: 10 });
    const d = c.defOf(pt());
    expect(c.dirtyMetrics()).toEqual([]);
    c.seriesOf(d, pt(), res('a'), scope);
    expect(c.dirtyMetrics()).toEqual([d.id]);
    c.clearDirty();
    c.seriesOf(d, pt(), res('a'), scope);
    expect(c.dirtyMetrics()).toEqual([]);
  });

  it('records scope names and attribute keys', () => {
    const c = new MetricCatalog({ seriesCap: 10 });
    const d = c.defOf(pt());
    c.seriesOf(
      d,
      pt({ attributes: attrs({ b: { kind: 'bool', value: true }, a: { kind: 'empty' } }) }),
      res('a'),
      scope,
    );
    expect(c.entries()[0]?.scopes).toEqual(['lib']);
    expect(c.entries()[0]?.attributeKeys).toEqual(['a', 'b']);
  });
});

describe('MetricCatalog.note', () => {
  const ok = (agg: BucketAgg, reset = false): Normalized => ({
    kind: 'ok',
    agg,
    reset,
  });
  it('counts points, resets and skips, and feeds the sparkline', () => {
    const c = new MetricCatalog({ seriesCap: 10 });
    const d = c.defOf(pt());
    c.note(d.id, ok({ k: 'number', count: 1, sum: 4, min: 4, max: 4, last: 4, lastTime: 1 }), rel(0));
    c.note(d.id, ok({ k: 'counter', delta: 3, resets: 0 }, true), rel(MS));
    c.note(d.id, ok({ k: 'hist', count: 7, sum: 1, min: null, max: null, bounds: [], counts: [7] }), rel(MS));
    c.note(d.id, { kind: 'skip', reason: 'out-of-order' }, rel(MS));
    c.note(d.id, { kind: 'skip', reason: 'no-value' }, rel(MS));
    const e = c.entries()[0];
    expect(e).toMatchObject({ points: 5, resets: 1, outOfOrder: 1, noValue: 1 });
    expect(e?.spark.toJSON().sums).toEqual([4, 10]);
  });
});

describe('MetricCatalog serialization', () => {
  function build(): MetricCatalog {
    const c = new MetricCatalog({ seriesCap: 3 });
    const d = c.defOf(histPt([1, 2]));
    const g = c.defOf(pt({ unit: 'ms' }));
    c.defOf(pt({ unit: 'By' }));
    for (let i = 0; i < 6; i++) {
      const attributes = attrs({
        i: { kind: 'int', value: BigInt(i) * 10n ** 18n },
        d: { kind: 'double', value: i === 0 ? Number.NaN : i / 3 },
        x: { kind: 'bytes', value: new Uint8Array([i, 255]) },
        l: { kind: 'array', values: [{ kind: 'string', value: 's' }, { kind: 'empty' }] },
        m: { kind: 'kvlist', values: attrs({ z: { kind: 'bool', value: false } }) },
      });
      c.seriesOf(d, histPt([1, 2]), res(`r${i % 2}`), scope);
      c.seriesOf(g, pt({ attributes }), res(`r${i % 2}`), scope);
    }
    c.note(g.id, { kind: 'ok', agg: { k: 'counter', delta: 2, resets: 0 }, reset: true }, rel(3 * MS));
    return c;
  }

  it('round-trips deep-equal with stable series ids', () => {
    const c = build();
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    const back = MetricCatalog.from(json, { seriesCap: 3 }, 'rollups.metrics.catalog');
    expect(back.toJSON()).toEqual(c.toJSON());
    expect(back.entries()).toEqual(c.entries());
    expect(back.resources()).toEqual(c.resources());
    for (const e of c.entries()) expect(back.seriesDefs(e.id)).toEqual(c.seriesDefs(e.id));
    // Interning keeps working after a reload: same inputs, same ids, nothing new.
    const before = back.seriesDefs(1).length;
    back.seriesOf(back.defOf(pt({ unit: 'ms' })), pt({ unit: 'ms' }), res('r0'), scope);
    expect(back.seriesDefs(1).length).toBe(before);
  });

  it('fails fast with the path of the bad field', () => {
    const json = JSON.parse(JSON.stringify(build().toJSON()));
    json.metrics[0].series[0].resource = 99;
    expect(() => MetricCatalog.from(json, { seriesCap: 3 }, 'rollups.metrics.catalog')).toThrow(
      /rollups\.metrics\.catalog\.metrics\[0\]\.series\[0\]\.resource/,
    );
    expect(() => MetricCatalog.from({ nope: 1 }, { seriesCap: 3 }, 'rollups.metrics.catalog')).toThrow(
      /rollups\.metrics\.catalog/,
    );
  });
});

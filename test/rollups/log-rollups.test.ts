import { describe, expect, it } from 'vitest';
import type { AnyValue, Attributes } from '../../src/model/anyvalue.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { RelNanos, TraceId } from '../../src/model/ids.js';
import { MAX_FACET_VALUE_LENGTH } from '../../src/rollups/facet-values.js';
import { DEFAULT_LOG_FACETS, LogRollups } from '../../src/rollups/log-rollups.js';
import { logTarget } from '../ottl/fixtures.js';

const opts = { facetValueCap: 50, facetKeyCap: 50 };
const attrs = (o: Record<string, AnyValue>): Attributes => new Map(Object.entries(o));
const str = (value: string): AnyValue => ({ kind: 'string', value });
const int = (value: bigint): AnyValue => ({ kind: 'int', value });
const t = (n: number): RelNanos => n as RelNanos;

function fill(): LogRollups {
  const r = new LogRollups(opts);
  r.add(logTarget({ severityNumber: 17, time: t(1) }));
  r.add(logTarget({ severityNumber: 9, time: t(2), traceId: 'a'.repeat(32) as TraceId }));
  r.add(logTarget({ severityNumber: 0, time: null, observedTime: t(3) }));
  return r;
}

describe('LogRollups', () => {
  it('buckets and facets severity', () => {
    const r = fill();
    expect(r.buckets.total('error')).toBe(1);
    const sev = r.facets.top('severity', 10).map((x) => [x.value, x.count]);
    expect(sev).toContainEqual(['error', 1]);
    expect(sev).toContainEqual(['info', 1]);
    expect(sev).toContainEqual(['unspecified', 1]);
  });
  it('counts trace.present yes/no', () => {
    const r = fill();
    expect(r.facets.top('trace.present', 10)).toEqual([
      { value: 'no', count: 2 },
      { value: 'yes', count: 1 },
    ]);
  });
  it('leaves an empty eventName out of event.name', () => {
    const r = new LogRollups(opts);
    r.add(logTarget({ eventName: '' }));
    expect(r.facets.top('event.name', 10)).toEqual([]);
    r.add(logTarget({ eventName: 'login' }));
    expect(r.facets.top('event.name', 10)).toEqual([{ value: 'login', count: 1 }]);
  });
  it('facets scalar attributes but not kvlists', () => {
    const r = new LogRollups(opts);
    r.add(
      logTarget({
        attributes: attrs({
          code: int(42n),
          nested: { kind: 'kvlist', values: attrs({ a: str('b') }) },
          plain: str('x'),
        }),
      }),
    );
    expect(r.facets.top('code', 5)).toEqual([{ value: '42', count: 1 }]);
    expect(r.facets.top('plain', 5)).toEqual([{ value: 'x', count: 1 }]);
    expect(r.facets.keys()).not.toContain('nested');
  });
  it('skips attributes named like a core key', () => {
    const r = new LogRollups(opts);
    r.add(logTarget({ attributes: attrs({ 'service.name': str('spoof'), 'host.name': str('h') }) }));
    expect(r.facets.top('service.name', 5)).toEqual([{ value: 'checkout', count: 1 }]);
    expect(r.facets.top('host.name', 5)).toEqual([]);
  });
  it('truncates long values to the cap', () => {
    const r = new LogRollups(opts);
    r.add(logTarget({ attributes: attrs({ big: str('x'.repeat(1000)) }) }));
    expect(r.facets.top('big', 5)).toEqual([{ value: 'x'.repeat(MAX_FACET_VALUE_LENGTH), count: 1 }]);
  });
  it('truncation never splits a surrogate pair', () => {
    const r = new LogRollups(opts);
    // The emoji's high surrogate lands on the last kept unit.
    r.add(logTarget({ attributes: attrs({ big: str(`${'x'.repeat(MAX_FACET_VALUE_LENGTH - 1)}\u{1F600}tail`) }) }));
    expect(r.facets.top('big', 5)).toEqual([{ value: 'x'.repeat(MAX_FACET_VALUE_LENGTH - 1), count: 1 }]);
  });
  it('clusters the body', () => {
    const r = fill();
    expect(r.patterns.clusters().reduce((n, c) => n + c.count, 0)).toBe(3);
  });
  it('round-trips through JSON', () => {
    const r = fill();
    const ser = JSON.parse(JSON.stringify(r.toJSON()));
    expect(LogRollups.from(ser, opts).toJSON()).toEqual(r.toJSON());
  });
  it('rejects rollups without a pinned core facet', () => {
    const ser = JSON.parse(JSON.stringify(fill().toJSON()));
    ser.facets.pinned = ser.facets.pinned.filter((k: string) => k !== DEFAULT_LOG_FACETS[0]?.key);
    try {
      LogRollups.from(ser, opts, 'rollups.logs');
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(OtelHtmlError);
      if (e instanceof OtelHtmlError) {
        expect(e.code).toBe('invalid-report');
        expect(e.message).toContain('logs.facets.pinned');
      }
    }
  });
});

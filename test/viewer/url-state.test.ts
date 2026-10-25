import { describe, expect, test } from 'vitest';
import type { SpanId, TraceId } from '../../src/model/ids.js';
import {
  formatWindow,
  parseUrlState,
  parseWindow,
  serializeUrlState,
} from '../../src/viewer/state/url-state.js';

const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);

describe('parseUrlState', () => {
  test('round-trips a traces hash query', () => {
    const search = `q=${new URLSearchParams({ q: 'span.name == "x"' }).toString().slice(2)}&t=0~5000000&trace=${TRACE}`;
    const { state, errors } = parseUrlState(`#/traces?${search}`);
    expect(errors).toEqual([]);
    expect(state).toEqual({ q: 'span.name == "x"', t: '0~5000000', trace: TRACE });
    expect(serializeUrlState(state)).toBe(search);
  });

  test('accepts a leading question mark or a bare query', () => {
    expect(parseUrlState(`?span=${SPAN}`).state).toEqual({ span: SPAN });
    expect(parseUrlState(`span=${SPAN}`).state).toEqual({ span: SPAN });
    expect(parseUrlState('').state).toEqual({});
  });

  test('reports and drops an invalid t', () => {
    const r = parseUrlState('t=abc&mode=traces');
    expect(r.errors).toEqual(['t: expected <start>~<end> in nanoseconds, got abc']);
    expect(r.state).toEqual({ mode: 'traces' });
  });

  test('t beyond 2^53 is rejected, not rounded', () => {
    const r = parseUrlState('t=0~9007199254740993');
    expect(r.state).toEqual({});
    expect(r.errors).toEqual([
      't: expected <start>~<end> with start <= end and values <= 9007199254740991, got 0~9007199254740993',
    ]);
    expect(parseUrlState('t=5~4').errors).toHaveLength(1);
    expect(parseUrlState('t=9007199254740991~9007199254740991').state).toEqual({
      t: '9007199254740991~9007199254740991',
    });
  });

  test('reports invalid enums, ids, bad OTTL and empty values', () => {
    const r = parseUrlState(`mode=x&view=pie2&trace=zz&span=${TRACE}&q=${encodeURIComponent('a ==')}&group=`);
    expect(r.state).toEqual({});
    expect(r.errors.map((e) => e.split(':')[0])).toEqual(['mode', 'view', 'trace', 'span', 'q', 'group']);
    expect(r.errors[0]).toBe('mode: expected spans or traces, got x');
  });

  test('reports an unknown trace tab id and keeps none of it', () => {
    const r = parseUrlState('tab=overview');
    expect(r.state).toEqual({});
    expect(r.errors).toEqual([
      'tab: expected one of flame, waterfall, spans, services, errors, got overview',
    ]);
  });

  test('reports unknown and duplicate params, keeping none of the duplicates', () => {
    const r = parseUrlState('foo=1&text=a&text=b&tab=waterfall');
    expect(r.state).toEqual({ tab: 'waterfall' });
    expect(r.errors).toEqual([
      'foo: unknown parameter, got 1',
      'text: expected a single value, got 2 values: a, b',
    ]);
  });
});

describe('prefix stripping', () => {
  test('a ? inside a value does not truncate it', () => {
    expect(parseUrlState('text=what%3F&group=a?b').state).toEqual({ text: 'what?', group: 'a?b' });
  });
});

describe('serializeUrlState', () => {
  test('uses a stable key order', () => {
    expect(
      serializeUrlState({
        sort: 's',
        span: SPAN as SpanId,
        trace: TRACE as TraceId,
        view: 'pie',
        group: 'g',
        mode: 'traces',
        t: '1~2',
        text: 'x',
        q: 'a == 1',
      }),
    ).toBe(`q=a+%3D%3D+1&text=x&t=1~2&mode=traces&group=g&view=pie&trace=${TRACE}&span=${SPAN}&sort=s`);
  });
});

describe('window helpers', () => {
  test('parseWindow and formatWindow are inverse', () => {
    expect(parseWindow('10~20')).toEqual({ start: 10, end: 20 });
    expect(formatWindow({ start: 10, end: 20 })).toBe('10~20');
  });

  test('formatWindow refuses unsafe or inverted windows', () => {
    expect(() => formatWindow({ start: 5, end: 4 })).toThrow(/window/);
    expect(() => formatWindow({ start: 0, end: 2 ** 53 })).toThrow(/window/);
    expect(() => formatWindow({ start: -1, end: 4 })).toThrow(/window/);
    expect(() => parseWindow('x')).toThrow(/window/);
  });
});

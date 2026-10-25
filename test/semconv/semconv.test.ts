import { describe, expect, it } from 'vitest';
import type { AnyValue } from '../../src/model/anyvalue.js';
import type { RelNanos, UnixNanos } from '../../src/model/ids.js';
import { formatBytes, formatDuration, formatTime } from '../../src/semconv/formatters.js';
import { groupAttributes } from '../../src/semconv/groups.js';
import { isServiceEntry, resourceName, serviceName } from '../../src/semconv/resource-name.js';
import { spanTarget } from '../ottl/fixtures.js';

const str = (value: string): AnyValue => ({ kind: 'string', value });

describe('resourceName', () => {
  it('joins method and route', () => {
    const { span } = spanTarget({
      attributes: new Map([
        ['http.request.method', str('GET')],
        ['http.route', str('/api/cart')],
      ]),
    });
    expect(resourceName(span)).toBe('GET /api/cart');
  });
  it('falls back to the span name when either is missing', () => {
    const { span } = spanTarget({ name: 'db.query', attributes: new Map([['http.route', str('/x')]]) });
    expect(resourceName(span)).toBe('db.query');
  });
});

describe('serviceName', () => {
  it('reads service.name and falls back to unknown_service', () => {
    const { resource } = spanTarget();
    expect(serviceName(resource)).toBe('checkout');
    expect(serviceName({ ...resource, attributes: new Map() })).toBe('unknown_service');
    expect(serviceName({ ...resource, attributes: new Map([['service.name', str('')]]) })).toBe(
      'unknown_service',
    );
  });
  it('uses unknown_service:<process.executable.name> when service.name is unset', () => {
    const { resource } = spanTarget();
    const attributes = new Map([['process.executable.name', str('node')]]);
    expect(serviceName({ ...resource, attributes })).toBe('unknown_service:node');
    const empty = new Map([
      ['service.name', str('')],
      ['process.executable.name', str('java')],
    ]);
    expect(serviceName({ ...resource, attributes: empty })).toBe('unknown_service:java');
    expect(serviceName({ ...resource, attributes: new Map([['process.executable.name', str('')]]) })).toBe(
      'unknown_service',
    );
  });
});

describe('isServiceEntry', () => {
  const { span } = spanTarget();
  const root = spanTarget({ parentSpanId: null }).span;
  it('is true for roots, missing parents and cross-service parents', () => {
    expect(isServiceEntry(root, undefined, 'a', undefined)).toBe(true);
    expect(isServiceEntry(span, undefined, 'a', undefined)).toBe(true);
    expect(isServiceEntry(span, root, 'a', 'b')).toBe(true);
  });
  it('is false for same-service parents', () => {
    expect(isServiceEntry(span, root, 'a', 'a')).toBe(false);
  });
});

describe('groupAttributes', () => {
  it('groups by namespace in table order with Other last', () => {
    const g = groupAttributes(
      new Map([
        ['zzz', str('1')],
        ['http.request.method', str('GET')],
        ['db.system', str('pg')],
        ['http.route', str('/')],
        ['http', str('bare')],
        ['httpx.y', str('not http')],
      ]),
    );
    expect(g.map((x) => x.label)).toEqual(['HTTP', 'Database', 'Other']);
    expect(g[0]?.entries.map(([k]) => k)).toEqual(['http', 'http.request.method', 'http.route']);
    expect(g[2]?.entries.map(([k]) => k)).toEqual(['httpx.y', 'zzz']);
  });
});

describe('formatters', () => {
  it('formatDuration', () => {
    expect(formatDuration(1_240_000_000)).toBe('1.24 s');
    expect(formatDuration(312_000_000)).toBe('312 ms');
    expect(formatDuration(84_000)).toBe('84 µs');
    expect(formatDuration(850)).toBe('850 ns');
    expect(formatDuration(0)).toBe('0 ns');
    expect(formatDuration(999_600)).toBe('1 ms');
    expect(formatDuration(125_000_000_000)).toBe('125 s');
    expect(formatDuration(-1_500_000)).toBe('-1.5 ms');
  });
  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1 MiB');
    expect(formatBytes(1023.99 * 1024)).toBe('1020 KiB');
  });
  it('formatTime', () => {
    const epoch = 1_700_000_000_000_000_000n as UnixNanos;
    expect(formatTime(1_000_000 as RelNanos, epoch)).toBe('2023-11-14T22:13:20.001Z');
  });
});

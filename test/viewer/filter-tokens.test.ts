import { describe, expect, test } from 'vitest';
import {
  type FilterToken,
  facetKeyToPath,
  ottlToTokens,
  tokensToOttl,
} from '../../src/viewer/components/filter-tokens.js';

const SERVICE = 'resource.attributes["service.name"]';

describe('tokensToOttl', () => {
  test('and-joins tokens and regex-escapes contains', () => {
    const tokens: FilterToken[] = [
      { key: SERVICE, op: '==', value: 'checkout' },
      { key: 'span.name', op: 'contains', value: 'a.b' },
    ];
    expect(tokensToOttl(tokens)).toBe(`${SERVICE} == "checkout" and IsMatch(span.name, "a\\\\.b")`);
  });

  test('empty list is null', () => {
    expect(tokensToOttl([])).toBeNull();
  });

  test('exists and not exists compare with nil; numbers and booleans print as OTTL literals', () => {
    expect(
      tokensToOttl([
        { key: 'span.attributes["a"]', op: 'exists', value: null },
        { key: 'span.attributes["b"]', op: 'not exists', value: null },
        { key: 'span.attributes["n"]', op: '>=', value: 5 },
        { key: 'span.attributes["f"]', op: '<', value: 1.5 },
        { key: 'span.attributes["ok"]', op: '==', value: true },
      ]),
    ).toBe(
      'span.attributes["a"] != nil and span.attributes["b"] == nil and span.attributes["n"] >= 5 and span.attributes["f"] < 1.5 and span.attributes["ok"] == true',
    );
  });

  test('rejects a key that is not an OTTL path or expression', () => {
    expect(() => tokensToOttl([{ key: '== ==', op: '==', value: 1 }])).toThrow(/key/);
  });
});

describe('ottlToTokens', () => {
  test('inverts tokensToOttl', () => {
    const tokens: FilterToken[] = [
      { key: SERVICE, op: '==', value: 'checkout' },
      { key: 'span.name', op: 'contains', value: 'a.b' },
      { key: 'span.attributes["a"]', op: 'exists', value: null },
      { key: 'span.attributes["b"]', op: 'not exists', value: null },
      { key: 'span.attributes["n"]', op: '>', value: 7 },
      { key: 'span.attributes["ok"]', op: '!=', value: false },
    ];
    const src = tokensToOttl(tokens);
    expect(src).not.toBeNull();
    expect(ottlToTokens(src ?? '')).toEqual(tokens);
  });

  test('or, not-flat and unparsable conditions are null', () => {
    expect(ottlToTokens('a == 1 or b == 2')).toBeNull();
    expect(ottlToTokens('not (a == 1)')).toBeNull();
    expect(ottlToTokens('a == ')).toBeNull();
    expect(ottlToTokens('IsMatch(span.name, "a.*")')).toBeNull();
  });

  test('duration expression keys round-trip', () => {
    const key = 'span.end_time_unix_nano - span.start_time_unix_nano';
    const tokens: FilterToken[] = [{ key, op: '>=', value: 1000 }];
    expect(ottlToTokens(tokensToOttl(tokens) ?? '')).toEqual(tokens);
  });
});

describe('facetKeyToPath', () => {
  test('maps core keys and falls back to span attributes', () => {
    expect(facetKeyToPath('service.name', 'span')).toBe(SERVICE);
    expect(facetKeyToPath('status.code', 'span')).toBe('span.status.code');
    expect(facetKeyToPath('http.method', 'span')).toBe('span.attributes["http.method"]');
  });

  test('scopes address resource and span attributes without any in-band prefix', () => {
    expect(facetKeyToPath('host.name', 'span', 'resource')).toBe('resource.attributes["host.name"]');
    expect(facetKeyToPath('a"b', 'span', 'resource')).toBe('resource.attributes["a\\"b"]');
    expect(facetKeyToPath('instrumentation_scope.name', 'span')).toBe('instrumentation_scope.name');
    // the same text under the attribute scope never hits a core field
    expect(facetKeyToPath('service.name', 'span', 'attribute')).toBe('span.attributes["service.name"]');
  });

  test('an attribute literally named resource:foo stays a span attribute', () => {
    expect(facetKeyToPath('resource:foo', 'span')).toBe('span.attributes["resource:foo"]');
    expect(facetKeyToPath('resource:foo', 'span', 'attribute')).toBe('span.attributes["resource:foo"]');
    expect(facetKeyToPath('resource:foo', 'span', 'resource')).toBe('resource.attributes["resource:foo"]');
  });
});

describe('enum right-hand sides', () => {
  test('round-trip between OTTL and tokens', () => {
    const tokens = ottlToTokens('span.status.code != STATUS_CODE_ERROR and span.name == "x"');
    expect(tokens).toEqual([
      { key: 'span.status.code', op: '!=', value: 'STATUS_CODE_ERROR', enum: true },
      { key: 'span.name', op: '==', value: 'x' },
    ]);
    expect(tokensToOttl(tokens ?? [])).toBe('span.status.code != STATUS_CODE_ERROR and span.name == "x"');
  });

  test('ordering comparisons against an enum name are tokens too', () => {
    const src =
      'log.severity_number >= SEVERITY_NUMBER_WARN and log.severity_number <= SEVERITY_NUMBER_WARN4';
    const tokens = ottlToTokens(src);
    expect(tokens).toEqual([
      { key: 'log.severity_number', op: '>=', value: 'SEVERITY_NUMBER_WARN', enum: true },
      { key: 'log.severity_number', op: '<=', value: 'SEVERITY_NUMBER_WARN4', enum: true },
    ]);
    expect(tokensToOttl(tokens ?? [])).toBe(src);
  });
});

import { describe, expect, test } from 'vitest';
import { compileCondition } from '../../src/ottl/compile.js';
import { spanTarget } from './fixtures.js';

const target = spanTarget();
const run = (src: string, t = target) => compileCondition(src, 'span').test(t);

describe('span conditions', () => {
  test.each([
    ['span.attributes["http.response.status_code"] >= 500', true],
    ['attributes["http.response.status_code"] == "503"', false],
    ['attributes["http.response.status_code"] != "503"', true],
    ['attributes["missing"] == nil', true],
    ['attributes["http.route"] != nil', true],
    ['status.code == STATUS_CODE_ERROR and resource.attributes["service.name"] == "checkout"', true],
    ['span.end_time_unix_nano - span.start_time_unix_nano > 250000000', true],
    ['IsMatch(span.name, "^POST ")', false],
    ['IsMatch(span.name, "^GET ")', true],
    ['IsMatch(attributes["http.route"], "cart$")', true],
    ['IsMatch(attributes["missing"], "x")', false],
    ['IsMatch(attributes["http.response.status_code"], "503")', false],
    ['not IsRootSpan()', true],
    ['Len(span.name) > 3', true],
    ['Len(attributes["list"]) == 2', true],
    ['Len(attributes["nested"]) == 1', true],
    ['Len(attributes["missing"]) == nil', true],
    ['kind == SPAN_KIND_SERVER', true],
    ['span.kind == SPAN_KIND_CLIENT', false],
    ['status.message == "upstream failed"', true],
    ['trace_state == "k=v"', true],
    ['instrumentation_scope.name == "my.lib" and instrumentation_scope.version == "1.2"', true],
    ['trace_id.string == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', true],
    ['span_id.string == "bbbbbbbbbbbbbbbb"', true],
    ['parent_span_id.string == "cccccccccccccccc"', true],
    ['dropped_attributes_count == 0', true],
    ['attributes["nested"]["a"] == "deep"', true],
    ['attributes["list"][0] == "x"', true],
    ['attributes["list"][1] == 2', true],
    ['attributes["list"][5] == nil', true],
    ['attributes["http.route"]["x"] == nil', true],
    [
      'IsString(name) and IsInt(kind) and IsBool(true) and IsDouble(1.5) and IsMap(attributes) and IsList(attributes["list"])',
      true,
    ],
    ['IsString(1) or IsInt("a") or IsMap(nil) or IsList(1)', false],
    ['true', true],
    ['false or (true and not false)', true],
  ])('%s → %s', (src, expected) => {
    expect(run(src)).toBe(expected);
  });

  test('root span', () => {
    expect(run('IsRootSpan()', spanTarget({ parentSpanId: null }))).toBe(true);
    expect(run('parent_span_id.string == ""', spanTarget({ parentSpanId: null }))).toBe(true);
  });

  test('short circuits', () => {
    expect(run('true or Len(1) > (1/0)')).toBe(true);
    expect(run('false and Len(name) > 0')).toBe(false);
  });
});

describe('comparison semantics', () => {
  test.each([
    ['nil == nil', true],
    ['nil != nil', false],
    ['nil == 0', false],
    ['nil == ""', false],
    ['nil < 1', false],
    ['1 == 1.0', true],
    ['2 > 1.5', true],
    ['1 < 1.5', true],
    ['"a" < "b"', true],
    ['"b" <= "a"', false],
    ['"a" == 1', false],
    ['"a" != 1', true],
    ['"a" < 1', false],
    ['"a" > 1', false],
    ['true == true', true],
    ['true < false', false],
    ['true == 1', false],
    // exactness above 2^53
    ['9007199254740993 == 9007199254740992.0', false],
    ['9007199254740993 > 9007199254740992.0', true],
    ['9007199254740992 == 9007199254740992.0', true],
    ['1700000000123456789 > 1700000000123456768.0', true],
    ['9223372036854775807 < 9223372036854775808.0', true],
    ['-9223372036854775808 == -9223372036854775808.0', true],
    ['9223372036854775807 < 1000000000000000000000000000000.0', true],
    ['0 < 0.5', true],
    ['-1 > -1.5', true],
    // arithmetic
    ['7 / 2 == 3', true],
    ['7 / 2.0 == 3.5', true],
    ['7 / 0 == nil', true],
    ['"a" + 1 == nil', true],
    ['2 * 3 + 1 == 7', true],
    ['9223372036854775807 + 1 == -9223372036854775808', true],
    ['1.5 + 1 == 2.5', true],
  ])('%s → %s', (src, expected) => {
    expect(run(src)).toBe(expected);
  });
  test('NaN is unordered', () => {
    expect(run('0.0 / 0.0 == 0.0 / 0.0')).toBe(false);
    expect(run('0.0 / 0.0 != 0.0 / 0.0')).toBe(true);
    expect(run('0.0 / 0.0 < 1')).toBe(false);
    expect(run('0.0 / 0.0 > 1')).toBe(false);
  });
  test('nanosecond precision survives subtraction and comparison', () => {
    const t = spanTarget({ start: 1 as never, end: 2 as never });
    expect(run('end_time_unix_nano - start_time_unix_nano == 1', t)).toBe(true);
    expect(run('start_time_unix_nano == 1700000000000000001', t)).toBe(true);
  });
});

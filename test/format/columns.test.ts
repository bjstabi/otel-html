import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { type ColumnarPayload, decodeColumns } from '../../src/format/columns.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { SPAN_COLUMNS } from '../../src/format/specs.js';
import { OtelHtmlError } from '../../src/model/errors.js';

function codeOf(fn: () => unknown): OtelHtmlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected an OtelHtmlError');
}

/** The span payload of the frozen format-3 report: a real, valid payload to corrupt one cell of. */
const FIXTURE = new URL('../../fixtures/reports/format-3/data/chunks/spans/000000.js', import.meta.url);

describe('decode validation (invalid-report with precise paths)', () => {
  const good = (): ColumnarPayload =>
    reviveDataJson(unwrapDataFile(readFileSync(FIXTURE, 'utf8'), 'chunks/spans/000000')) as ColumnarPayload;
  /** A good payload with one cell replaced. */
  const withCell = (column: string, row: number, value: unknown): ColumnarPayload => {
    const p = good();
    const cells = [...(p.cols[column] ?? [])];
    cells[row] = value;
    return { ...p, cols: { ...p.cols, [column]: cells } };
  };

  test('a fixture payload decodes', () => {
    const p = good();
    expect(decodeColumns(SPAN_COLUMNS, p).rows).toHaveLength(p.n);
  });

  test('decode rejects a malformed payload', () => {
    expect(() => decodeColumns(SPAN_COLUMNS, { v: 2 })).toThrowError(/expected 1/);
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, { v: 2 }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('v');
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, 'nope')).code).toBe('invalid-report');
  });

  test('missing column', () => {
    const p = good();
    const { spanId: _dropped, ...cols } = p.cols;
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, { ...p, cols }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('cols.spanId');
  });

  test('column length mismatch', () => {
    const p = good();
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, { ...p, cols: { ...p.cols, name: [0] } }));
    expect(e.path).toBe('cols.name');
    expect(e.expected).toContain(String(p.n));
  });

  test('bad cell: malformed span id', () => {
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('spanId', 2, 'zz')));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('cols.spanId[2]');
  });

  test('bad cell: dictionary index out of range', () => {
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('name', 4, 99_999)));
    expect(e.path).toBe('cols.name[4]');
    expect(e.expected).toMatch(/dictionary index/);
  });

  test('bad cell: dangling resource ref and corrupt attrs', () => {
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('resource', 1, 1_000_000))).path).toBe(
      'cols.resource[1]',
    );
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('attributes', 0, [0, [9, 9]])));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toMatch(/^cols\.attributes\[0\]/);
  });

  test('bad json cell', () => {
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('status', 0, 99_999)));
    expect(e.path).toBe('cols.status[0]');
  });

  test('bad resource table entry', () => {
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, { ...good(), resources: [{ attributes: 'x' }] }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('resources[0].attributes');
  });

  test('bad time cell and non-integer int', () => {
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('start', 0, 'soon'))).path).toBe(
      'cols.start[0]',
    );
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('flags', 3, 1.5))).path).toBe('cols.flags[3]');
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('end', 1, { $i: 'x' }))).path).toBe(
      'cols.end[1]',
    );
  });
});

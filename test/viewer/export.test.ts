import { describe, expect, test } from 'vitest';
import { parseUnixNanos, type TraceId } from '../../src/model/ids.js';
import { createNormalizeContext, normalizeTraces } from '../../src/model/normalize.js';
import { parseOtlpJson } from '../../src/model/otlp-json.js';
import { csvCell, exportRows } from '../../src/viewer/components/export.js';
import type { SpanRow, TraceRow } from '../../src/viewer/data/span-query.js';
import { attr, span, T0, traceRequest } from '../../test-support/otlp-builders.js';

const text = (b: Blob): Promise<string> => b.text();

function spanRow(over: { name?: string; service?: string } = {}): SpanRow {
  return {
    span: {
      traceId: 'ab',
      spanId: 'cd',
      parentSpanId: null,
      name: over.name ?? 'GET /',
      kind: 2,
      start: 1000,
      end: 3000,
      status: { code: 2, message: '' },
    },
    service: over.service ?? 'web',
    resource: 'GET /',
    durationNs: 2000,
  } as unknown as SpanRow;
}

describe('csvCell', () => {
  test('quotes values with quotes, commas and newlines per RFC 4180', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell('l1\r\nl2')).toBe('"l1\r\nl2"');
  });

  test.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])('neutralises formula starter %j', (v) => {
    expect(csvCell(v).replace(/^"|"$/g, '')).toMatch(/^'/);
  });

  test('a neutralised value that also needs quoting is quoted', () => {
    expect(csvCell('=A1,B1')).toBe('"\'=A1,B1"');
  });
});

describe('exportRows', () => {
  test('csv has a header row, CRLF line ends and neutralises hostile cells', async () => {
    const blob = exportRows([spanRow({ name: '=HYPERLINK("http://x","y")' })], 'csv');
    expect(blob.type).toBe('text/csv;charset=utf-8');
    const lines = (await text(blob)).split('\r\n');
    expect(lines[0]).toBe('time_ns,trace_id,span_id,service,name,resource,duration_ns,status');
    expect(lines[1]).toBe('1000,ab,cd,web,"\'=HYPERLINK(""http://x"",""y"")",GET /,2000,error');
  });

  test('csv of trace rows uses trace columns', async () => {
    const row = {
      traceId: 'ab' as TraceId,
      root: null,
      rootSummary: { service: 'web', name: 'GET /', resource: 'GET /' },
      start: 5,
      durationNs: 9,
      spans: 3,
      errors: 1,
      shareComplete: false,
      serviceShare: [],
    } satisfies TraceRow;
    const out = (await text(exportRows([row], 'csv'))).split('\r\n');
    expect(out[0]).toBe('start_ns,trace_id,root_service,root_name,duration_ns,spans,errors');
    expect(out[1]).toBe('5,ab,web,GET /,9,3,1');
  });

  test('json is the row data as an array', async () => {
    const blob = exportRows([spanRow()], 'json');
    expect(blob.type).toBe('application/json');
    const parsed: unknown = JSON.parse(await text(blob));
    expect(parsed).toMatchObject([{ service: 'web', durationNs: 2000 }]);
  });

  test('otlp-json reuses spansToOtlpJson and parses back through the existing parser', async () => {
    const epoch = parseUnixNanos(T0, 'epoch');
    const ctx = createNormalizeContext(epoch);
    const spans = parseOtlpJson(
      JSON.stringify(
        traceRequest([span({ name: '</script>' })], [attr('service.name', { stringValue: 'svc' })]),
      ),
      'in.json',
    ).flatMap((r) => (r.signal === 'traces' ? normalizeTraces(r.request, ctx, 'in.json') : []));
    const blob = exportRows([spanRow()], 'otlp-json', {
      epoch,
      groups: [{ spans, resources: (r) => ctx.resources.get(r), scopes: (s) => ctx.scopes.get(s) }],
    });
    expect(blob.type).toBe('application/json');
    const again = createNormalizeContext(epoch);
    const back = parseOtlpJson(await text(blob), 'out.json').flatMap((r) =>
      r.signal === 'traces' ? normalizeTraces(r.request, again, 'out.json') : [],
    );
    expect(back).toEqual(spans);
  });

  test('otlp-json without span groups is a precise usage error', () => {
    expect(() => exportRows([spanRow()], 'otlp-json')).toThrow(/otlp-json/);
  });
});

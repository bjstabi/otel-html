import { expect, test } from 'vitest';
import { logsToOtlpJson, spansToOtlpJson } from '../../src/format/otlp-export.js';
import { parseUnixNanos } from '../../src/model/ids.js';
import { createNormalizeContext, normalizeLogs, normalizeTraces } from '../../src/model/normalize.js';
import { parseOtlpJson } from '../../src/model/otlp-json.js';
import {
  attr,
  logRecord,
  logsRequest,
  SPAN_ID,
  span,
  T0,
  TRACE_ID,
  traceRequest,
} from '../../test-support/otlp-builders.js';

const epoch = parseUnixNanos(T0, 'epoch');

function normalize(json: unknown) {
  const ctx = createNormalizeContext(epoch);
  const spans = parseOtlpJson(JSON.stringify(json), 'in.json').flatMap((r) =>
    r.signal === 'traces' ? normalizeTraces(r.request, ctx, 'in.json') : [],
  );
  return { ctx, spans };
}

const input = traceRequest(
  [
    span({
      parentSpanId: 'aaaaaaaaaaaaaaaa', // orphan
      traceState: 'a=b',
      flags: 257,
      attributes: [
        attr('s', { stringValue: '</script>' }),
        attr('i', { intValue: '9223372036854775807' }),
        attr('neg', { intValue: '-9223372036854775808' }),
        attr('d', { doubleValue: 1.5 }),
        attr('b', { boolValue: true }),
        attr('bytes', { bytesValue: 'AP8=' }),
        attr('arr', { arrayValue: { values: [{ stringValue: 'x' }, { intValue: '3' }] } }),
        attr('kv', { kvlistValue: { values: [attr('inner', { stringValue: 'y' })] } }),
      ],
      events: [
        {
          timeUnixNano: '1699999999999999000', // before the epoch: negative RelNanos
          name: 'ev',
          attributes: [attr('k', { stringValue: 'v' })],
          droppedAttributesCount: 2,
        },
      ],
      links: [
        {
          traceId: TRACE_ID,
          spanId: SPAN_ID,
          traceState: 't=1',
          flags: 1,
          attributes: [attr('l', { intValue: '4' })],
        },
      ],
      status: { code: 2, message: 'boom' },
      droppedAttributesCount: 1,
    }),
    span({ spanId: '1111111111111111', startTimeUnixNano: '1699999999999990000', endTimeUnixNano: T0 }),
  ],
  [attr('service.name', { stringValue: 'svc' })],
);

test('spansToOtlpJson parses back through parseOtlpJson to the same records', () => {
  const { ctx, spans } = normalize(input);
  expect(spans).toHaveLength(2);
  const out = spansToOtlpJson(
    spans,
    (r) => ctx.resources.get(r),
    (s) => ctx.scopes.get(s),
    epoch,
  );
  const again = normalize(out);
  expect(again.spans).toEqual(spans);
  expect(again.ctx.resources.entries()).toEqual(ctx.resources.entries());
  expect(again.ctx.scopes.entries()).toEqual(ctx.scopes.entries());
});

test('output is plain JSON with string nanos and hex ids', () => {
  const { ctx, spans } = normalize(input);
  const out = spansToOtlpJson(
    spans,
    (r) => ctx.resources.get(r),
    (s) => ctx.scopes.get(s),
    epoch,
  );
  const text = JSON.stringify(out);
  expect(text).toContain(`"startTimeUnixNano":"${T0}"`);
  expect(text).toContain(`"traceId":"${TRACE_ID}"`);
  expect(text).toContain('"intValue":"9223372036854775807"');
});

test('spans sharing a resource and scope are grouped under one entry', () => {
  const { ctx, spans } = normalize(input);
  const out = spansToOtlpJson(
    spans,
    (r) => ctx.resources.get(r),
    (s) => ctx.scopes.get(s),
    epoch,
  ) as {
    resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
  };
  expect(out.resourceSpans).toHaveLength(1);
  expect(out.resourceSpans[0]?.scopeSpans).toHaveLength(1);
  expect(out.resourceSpans[0]?.scopeSpans[0]?.spans).toHaveLength(2);
});

test('empty input exports an empty request', () => {
  expect(
    spansToOtlpJson(
      [],
      () => {
        throw new Error('unused');
      },
      () => {
        throw new Error('unused');
      },
      epoch,
    ),
  ).toEqual({ resourceSpans: [] });
});

function normalizeLogJson(json: unknown) {
  const ctx = createNormalizeContext(epoch);
  const logs = parseOtlpJson(JSON.stringify(json), 'in.json').flatMap((r) =>
    r.signal === 'logs' ? normalizeLogs(r.request, ctx, 'in.json') : [],
  );
  return { ctx, logs };
}

/** The `resourceLogs` entries of one builder request. */
const resourceLogsOf = (req: unknown): unknown[] => (req as { resourceLogs: unknown[] }).resourceLogs;

const logInput = {
  resourceLogs: [
    ...resourceLogsOf(
      logsRequest(
        [
          logRecord({
            severityNumber: 17,
            severityText: 'ERROR',
            body: { kvlistValue: { values: [attr('k', { arrayValue: { values: [{ intValue: '-3' }] } })] } },
            attributes: [attr('s', { stringValue: '</script>' })],
            traceId: TRACE_ID,
            spanId: SPAN_ID,
            flags: 1,
            eventName: 'ev',
            droppedAttributesCount: 2,
          }),
          // Observed time only, and no timestamp at all.
          logRecord({ timeUnixNano: '0', body: { stringValue: 'observed only' } }),
          logRecord({ timeUnixNano: '0', observedTimeUnixNano: '0', body: { bytesValue: 'AP8=' } }),
        ],
        [attr('service.name', { stringValue: 'a' })],
      ),
    ),
    ...resourceLogsOf(
      logsRequest(
        [logRecord({ body: { stringValue: 'other resource' } })],
        [attr('service.name', { stringValue: 'b' })],
      ),
    ),
  ],
};

test('logsToOtlpJson parses back through normalizeLogs to the same records', () => {
  const { ctx, logs } = normalizeLogJson(logInput);
  expect(logs).toHaveLength(4);
  const rows = logs.map((log) => ({
    log,
    resource: ctx.resources.get(log.resource),
    scope: ctx.scopes.get(log.scope),
  }));
  const out = logsToOtlpJson(rows, epoch) as { resourceLogs: unknown[] };
  expect(out.resourceLogs).toHaveLength(2);
  const again = normalizeLogJson(out);
  expect(again.logs).toEqual(logs);
  expect(again.ctx.resources.entries()).toEqual(ctx.resources.entries());
  expect(again.ctx.scopes.entries()).toEqual(ctx.scopes.entries());
});

test('logs of one resource and scope object share one entry', () => {
  const { ctx, logs } = normalizeLogJson(logInput);
  const rows = logs.map((log) => ({
    log,
    resource: ctx.resources.get(log.resource),
    scope: ctx.scopes.get(log.scope),
  }));
  const out = logsToOtlpJson(rows, epoch) as { resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[] };
  expect(out.resourceLogs.map((r) => r.scopeLogs.map((s) => s.logRecords.length))).toEqual([[3], [1]]);
  expect(logsToOtlpJson([], epoch)).toEqual({ resourceLogs: [] });
});

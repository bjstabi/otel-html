import { describe, expect, test } from 'vitest';
import { SIGNAL_SERVICES, serviceAtPath, serviceOf } from '../../src/receiver/signals.js';
import {
  gauge,
  logRecord,
  logsRequest,
  metricsRequest,
  span,
  traceRequest,
} from '../../test-support/otlp-builders.js';
import { otlp } from '../../test-support/writer-deps.js';

describe('SIGNAL_SERVICES', () => {
  test('is keyed by path and by signal', () => {
    expect(serviceAtPath('/v1/logs')?.signal).toBe('logs');
    expect(serviceAtPath('/v1/x')).toBeUndefined();
    expect(SIGNAL_SERVICES.map((s) => serviceOf(s.signal).path)).toEqual(SIGNAL_SERVICES.map((s) => s.path));
    expect(serviceOf('metrics').rejectedField).toBe('rejectedDataPoints');
  });

  test('recordCount counts spans across scopes', () => {
    const json = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            { scope: { name: 'a' }, spans: [span(), span()] },
            { scope: { name: 'b' }, spans: [span(), span(), span()] },
          ],
        },
      ],
    };
    expect(serviceOf('traces').recordCount(otlp(json))).toBe(5);
    expect(serviceOf('traces').recordCount(otlp(traceRequest([span()])))).toBe(1);
  });

  test('recordCount of another signal is an invariant violation', () => {
    expect(() => serviceOf('traces').recordCount(otlp(logsRequest([logRecord()])))).toThrow(
      /invariant violated/,
    );
    expect(() => serviceOf('logs').recordCount(otlp(traceRequest([span()])))).toThrow(/invariant violated/);
    expect(() => serviceOf('metrics').recordCount(otlp(traceRequest([span()])))).toThrow(
      /invariant violated/,
    );
  });

  test('recordCount counts log records', () => {
    expect(serviceOf('logs').recordCount(otlp(logsRequest([logRecord(), logRecord()])))).toBe(2);
  });

  test('recordCount counts metric data points of every kind, from the plain and the decoded form', () => {
    const point = { timeUnixNano: '1700000000000000000', asInt: '1' };
    const gaugeOnly = otlp(metricsRequest([gauge('g', [point, point])]));
    expect(gaugeOnly.signal === 'metrics' && gaugeOnly.plain !== undefined).toBe(true);
    expect(serviceOf('metrics').recordCount(gaugeOnly)).toBe(2);

    const mixed = otlp(
      metricsRequest([
        gauge('g', [point, point]),
        {
          name: 'h',
          histogram: {
            aggregationTemporality: 1,
            dataPoints: [
              {
                timeUnixNano: '1700000000000000000',
                count: '1',
                sum: 1,
                bucketCounts: ['1'],
                explicitBounds: [],
              },
            ],
          },
        },
      ]),
    );
    expect(mixed.signal === 'metrics' && mixed.plain === undefined).toBe(true);
    expect(serviceOf('metrics').recordCount(mixed)).toBe(3);
  });

  test('respond builds the signal response with a partial success only when entries were rejected', () => {
    const traces = serviceOf('traces');
    expect(traces.respond(10, 3, 'bad')).toMatchObject({
      partialSuccess: { rejectedSpans: 3n, errorMessage: 'bad' },
    });
    expect(Reflect.get(traces.respond(10, 0, null), 'partialSuccess')).toBeUndefined();
    expect(serviceOf('logs').respond(1, 2, 'x')).toMatchObject({
      partialSuccess: { rejectedLogRecords: 2n },
    });
    expect(serviceOf('metrics').respond(1, 2, 'x')).toMatchObject({
      partialSuccess: { rejectedDataPoints: 2n },
    });
  });
});

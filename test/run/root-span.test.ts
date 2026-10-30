import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { KeyValueSchema } from '../../src/model/gen/opentelemetry/proto/common/v1/common_pb.js';
import {
  Span_SpanKind,
  Status_StatusCode,
} from '../../src/model/gen/opentelemetry/proto/trace/v1/trace_pb.js';
import { parseUnixNanos } from '../../src/model/ids.js';
import {
  type ChildExit,
  EXIT_CODE_OF_SIGNAL,
  exitCodeOf,
  type RootSpanInput,
  rootSpanRequest,
  traceparentOf,
} from '../../src/run/root-span.js';

const traceId = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const spanId = Uint8Array.from({ length: 8 }, (_, i) => 0x10 + i);

function input(exit: ChildExit, command: readonly string[] = ['pytest', '-q']): RootSpanInput {
  return {
    traceId,
    spanId,
    command,
    pid: 4242,
    start: parseUnixNanos(1_700_000_000_000_000_000n, 'start'),
    end: parseUnixNanos(1_700_000_002_000_000_000n, 'end'),
    exit,
    resource: [create(KeyValueSchema, { key: 'service.name' })],
  };
}

function spanOf(i: RootSpanInput) {
  const span = rootSpanRequest(i).resourceSpans[0]?.scopeSpans[0]?.spans[0];
  if (span === undefined) throw new Error('no span');
  return span;
}

function attrOf(i: RootSpanInput, key: string) {
  return spanOf(i).attributes.find((a) => a.key === key)?.value?.value;
}

describe('rootSpanRequest', () => {
  test('a clean exit leaves the status unset and records the exit code', () => {
    const span = spanOf(input({ code: 0, signal: null }));
    expect(span.name).toBe('pytest');
    expect(span.kind).toBe(Span_SpanKind.INTERNAL);
    expect(span.traceId).toEqual(traceId);
    expect(span.spanId).toEqual(spanId);
    expect(span.parentSpanId).toEqual(new Uint8Array());
    expect(span.startTimeUnixNano).toBe(1_700_000_000_000_000_000n);
    expect(span.endTimeUnixNano).toBe(1_700_000_002_000_000_000n);
    expect(span.status?.code ?? Status_StatusCode.UNSET).toBe(Status_StatusCode.UNSET);
    expect(attrOf(input({ code: 0, signal: null }), 'process.exit.code')).toEqual({
      case: 'intValue',
      value: 0n,
    });
    expect(attrOf(input({ code: 0, signal: null }), 'process.pid')).toEqual({
      case: 'intValue',
      value: 4242n,
    });
    expect(attrOf(input({ code: 0, signal: null }), 'process.executable.name')).toEqual({
      case: 'stringValue',
      value: 'pytest',
    });
    const args = attrOf(input({ code: 0, signal: null }), 'process.command_args');
    expect(args?.case === 'arrayValue' ? args.value.values.map((v) => v.value.value) : null).toEqual([
      'pytest',
      '-q',
    ]);
  });

  test('a non-zero exit is an error naming the code', () => {
    const span = spanOf(input({ code: 3, signal: null }));
    expect(span.status?.code).toBe(Status_StatusCode.ERROR);
    expect(span.status?.message).toBe('exit code 3');
  });

  test('a signalled child is an error naming the signal and has no exit code', () => {
    const i = input({ code: null, signal: 'SIGTERM' });
    expect(spanOf(i).status?.code).toBe(Status_StatusCode.ERROR);
    expect(spanOf(i).status?.message).toBe('killed by SIGTERM');
    expect(attrOf(i, 'process.exit.code')).toBeUndefined();
  });

  test('the name is the basename without a trailing .exe', () => {
    expect(spanOf(input({ code: 0, signal: null }, ['C:\\tools\\go.exe', 'test'])).name).toBe('go');
    expect(spanOf(input({ code: 0, signal: null }, ['/usr/bin/node'])).name).toBe('node');
  });

  test('carries the resource and the otel-html scope', () => {
    const rs = rootSpanRequest(input({ code: 0, signal: null })).resourceSpans[0];
    expect(rs?.resource?.attributes.map((a) => a.key)).toEqual(['service.name']);
    expect(rs?.scopeSpans[0]?.scope?.name).toBe('otel-html');
    expect(rs?.scopeSpans[0]?.scope?.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('exit codes', () => {
  test('exitCodeOf: the code, or 128 plus the signal number', () => {
    expect(exitCodeOf({ code: 0, signal: null })).toBe(0);
    expect(exitCodeOf({ code: 3, signal: null })).toBe(3);
    expect(exitCodeOf({ code: null, signal: 'SIGTERM' })).toBe(143);
    expect(exitCodeOf({ code: null, signal: 'SIGKILL' })).toBe(137);
    expect(exitCodeOf({ code: null, signal: 'SIGWINCH' })).toBe(128);
    expect(EXIT_CODE_OF_SIGNAL.SIGINT).toBe(2);
    // A crash is the common way a child dies by signal.
    expect(exitCodeOf({ code: null, signal: 'SIGILL' })).toBe(132);
    expect(exitCodeOf({ code: null, signal: 'SIGTRAP' })).toBe(133);
    expect(exitCodeOf({ code: null, signal: 'SIGBUS' })).toBe(135);
    expect(exitCodeOf({ code: null, signal: 'SIGFPE' })).toBe(136);
  });
});

describe('traceparentOf', () => {
  test('is version 00, lowercase hex ids and the sampled flag', () => {
    expect(traceparentOf(traceId, spanId)).toBe('00-a0a1a2a3a4a5a6a7a8a9aaabacadaeaf-1011121314151617-01');
  });
});

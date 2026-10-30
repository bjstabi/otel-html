import { create } from '@bufbuild/protobuf';
import pkg from '../../package.json' with { type: 'json' };
import {
  type ExportTraceServiceRequest,
  ExportTraceServiceRequestSchema,
} from '../model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import type { KeyValue } from '../model/gen/opentelemetry/proto/common/v1/common_pb.js';
import { ResourceSchema } from '../model/gen/opentelemetry/proto/resource/v1/resource_pb.js';
import {
  ResourceSpansSchema,
  ScopeSpansSchema,
  Span_SpanKind,
  SpanSchema,
  Status_StatusCode,
  StatusSchema,
} from '../model/gen/opentelemetry/proto/trace/v1/trace_pb.js';
import type { UnixNanos } from '../model/ids.js';
import { attributesToKeyValues } from '../model/sdk-spans.js';

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RootSpanInput {
  traceId: Uint8Array;
  spanId: Uint8Array;
  command: readonly string[];
  pid: number;
  start: UnixNanos;
  end: UnixNanos;
  exit: ChildExit;
  resource: readonly KeyValue[];
}

/**
 * POSIX exit code for a child killed by a signal: 128 + the signal's number. The numbers are Linux's (a few, such as
 * SIGBUS and SIGUSR1, differ on macOS); a literal table keeps this free of node:os.
 */
export const EXIT_CODE_OF_SIGNAL: Readonly<Partial<Record<NodeJS.Signals, number>>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

const SIGNALLED_BASE = 128;
// The trace flags of a sampled root span (01), with "has is-remote" set and is-remote clear: the span is local.
const SAMPLED_LOCAL_FLAGS = 0x101;
const SCOPE_NAME = 'otel-html';

export function exitCodeOf({ code, signal }: ChildExit): number {
  if (code !== null) return code;
  return SIGNALLED_BASE + (signal === null ? 0 : (EXIT_CODE_OF_SIGNAL[signal] ?? 0));
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** `00-<trace id>-<span id>-01`: the W3C trace context of the root span, sampled. */
export function traceparentOf(traceId: Uint8Array, spanId: Uint8Array): string {
  return `00-${hex(traceId)}-${hex(spanId)}-01`;
}

/** The command's basename, without a trailing `.exe`; both path separators count. */
export function executableName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.exe$/i, '');
}

function statusOf({ code, signal }: ChildExit): { code: Status_StatusCode; message: string } {
  if (signal !== null) return { code: Status_StatusCode.ERROR, message: `killed by ${signal}` };
  if (code !== null && code !== 0) return { code: Status_StatusCode.ERROR, message: `exit code ${code}` };
  return { code: Status_StatusCode.UNSET, message: '' };
}

export function rootSpanRequest(input: RootSpanInput): ExportTraceServiceRequest {
  const executable = executableName(input.command[0] ?? '');
  const span = create(SpanSchema, {
    traceId: input.traceId,
    spanId: input.spanId,
    name: executable,
    kind: Span_SpanKind.INTERNAL,
    startTimeUnixNano: input.start,
    endTimeUnixNano: input.end,
    attributes: attributesToKeyValues({
      'process.command_args': [...input.command],
      'process.executable.name': executable,
      'process.pid': input.pid,
      ...(input.exit.code === null ? {} : { 'process.exit.code': input.exit.code }),
    }),
    status: create(StatusSchema, statusOf(input.exit)),
    flags: SAMPLED_LOCAL_FLAGS,
  });
  return create(ExportTraceServiceRequestSchema, {
    resourceSpans: [
      create(ResourceSpansSchema, {
        resource: create(ResourceSchema, { attributes: [...input.resource] }),
        scopeSpans: [
          create(ScopeSpansSchema, { scope: { name: SCOPE_NAME, version: pkg.version }, spans: [span] }),
        ],
      }),
    ],
  });
}

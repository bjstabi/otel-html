import { OtelHtmlError } from '../model/errors.js';
import { noSignal, type OtlpRequest, type OtlpSignal } from '../model/otlp-json.js';
import { OtlpJsonStream } from '../model/otlp-json-stream.js';
import { streamOtlpProtobuf } from '../model/otlp-proto.js';
import type { Logger } from '../writer/ports.js';
import type { WriterSession } from '../writer/session.js';
import { serviceOf } from './signals.js';

export type BodyEncoding = 'json' | 'protobuf';

export interface ReceiveResult {
  accepted: number;
  rejected: number;
  errorMessage: string | null;
}

export interface ReceiverStats {
  requests: number;
  bytes: number;
  accepted: Record<OtlpSignal, number>;
  rejected: Record<OtlpSignal, number>;
}

export interface ReceiverOptions {
  inflightBudgetBytes: number;
}

export interface Receiver {
  /** `transport` names the source: `otlp/http` or `otlp/grpc`. */
  receive(
    signal: OtlpSignal,
    body: Uint8Array,
    encoding: BodyEncoding,
    transport: string,
  ): Promise<ReceiveResult>;
  stats(): ReceiverStats;
  /** Stop accepting (later receives fail `receiver-busy`), wait for the receives in progress. Idempotent. */
  close(): Promise<void>;
}

const ROOT_KEY: Readonly<Record<OtlpSignal, string>> = {
  traces: 'resourceSpans',
  logs: 'resourceLogs',
  metrics: 'resourceMetrics',
};

function perSignal(): Record<OtlpSignal, number> {
  return { traces: 0, logs: 0, metrics: 0 };
}

/** The resource entries of a JSON body. A body with no signal key at all (`{}`) holds none. */
function jsonEntries(signal: OtlpSignal, body: Uint8Array, source: string): OtlpRequest[] {
  const stream = new OtlpJsonStream(source, { lines: false });
  let entries: OtlpRequest[];
  try {
    entries = stream.push(new TextDecoder().decode(body));
    stream.end();
  } catch (e) {
    if (e instanceof OtelHtmlError && e.message === noSignal(source).message) return [];
    throw e;
  }
  for (const entry of entries) {
    if (entry.signal !== signal) {
      throw new OtelHtmlError('invalid-otlp', {
        message: `${source}: expected ${ROOT_KEY[signal]}, got ${ROOT_KEY[entry.signal]}`,
      });
    }
  }
  return entries;
}

function entriesOf(
  signal: OtlpSignal,
  body: Uint8Array,
  encoding: BodyEncoding,
  source: string,
): Iterable<OtlpRequest> {
  switch (encoding) {
    case 'json':
      return jsonEntries(signal, body, source);
    case 'protobuf':
      return streamOtlpProtobuf(body, signal, source);
    default: {
      const unknown: never = encoding;
      throw new Error(`invariant violated: unknown encoding ${String(unknown)}`);
    }
  }
}

function isRejection(e: unknown): e is OtelHtmlError {
  return e instanceof OtelHtmlError && (e.code === 'invalid-otlp' || e.code === 'time-out-of-range');
}

export function createReceiver(
  session: WriterSession,
  options: ReceiverOptions,
  deps: { logger: Logger },
): Receiver {
  const { logger } = deps;
  const totals: ReceiverStats = { requests: 0, bytes: 0, accepted: perSignal(), rejected: perSignal() };
  /** Body bytes of the receives in progress or queued. */
  let inflightBytes = 0;
  const pending = new Set<Promise<unknown>>();
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;

  async function process(
    signal: OtlpSignal,
    body: Uint8Array,
    encoding: BodyEncoding,
    source: string,
  ): Promise<ReceiveResult> {
    const service = serviceOf(signal);
    let accepted = 0;
    let rejected = 0;
    let acceptedEntries = 0;
    let rejectedEntries = 0;
    let errorMessage: string | null = null;
    let failure: { error: unknown } | null = null;
    try {
      for (const entry of entriesOf(signal, body, encoding, source)) {
        const records = service.recordCount(entry);
        try {
          if (records > 0) await session.add(entry, source, { partial: true });
          accepted += records;
          acceptedEntries++;
        } catch (e) {
          if (!isRejection(e)) throw e;
          rejected += records;
          rejectedEntries++;
          errorMessage ??= e.message;
          logger.debug('receiver rejected an entry', { signal, source, message: e.message });
        }
      }
    } catch (e) {
      failure = { error: e };
    }
    try {
      await session.endInput();
    } catch (e) {
      failure ??= { error: e };
    }
    if (failure !== null) throw failure.error;
    totals.accepted[signal] += accepted;
    totals.rejected[signal] += rejected;
    if (rejectedEntries > 0 && acceptedEntries === 0) {
      throw new OtelHtmlError('invalid-otlp', {
        message: errorMessage ?? `${source}: every entry was rejected`,
      });
    }
    return { accepted, rejected, errorMessage };
  }

  return {
    async receive(signal, body, encoding, transport) {
      if (closed) throw new OtelHtmlError('receiver-busy', { message: 'receiver is closing' });
      if (pending.size > 0 && inflightBytes + body.length > options.inflightBudgetBytes) {
        throw new OtelHtmlError('receiver-busy', {
          message: `receiver is busy: ${inflightBytes + body.length} bytes in flight exceed ${options.inflightBudgetBytes}`,
        });
      }
      totals.requests++;
      totals.bytes += body.length;
      inflightBytes += body.length;
      const run = tail.then(() => process(signal, body, encoding, transport));
      tail = run.catch(() => undefined);
      pending.add(run);
      try {
        return await run;
      } finally {
        pending.delete(run);
        inflightBytes -= body.length;
      }
    },
    stats: () => ({
      requests: totals.requests,
      bytes: totals.bytes,
      accepted: { ...totals.accepted },
      rejected: { ...totals.rejected },
    }),
    async close() {
      closed = true;
      await tail;
    },
  };
}

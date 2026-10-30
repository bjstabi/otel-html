import { OtelHtmlError } from '../model/errors.js';
import { NO_SIGNAL_PATH, type OtlpRequest, type OtlpSignal } from '../model/otlp-json.js';
import { OtlpJsonStream } from '../model/otlp-json-stream.js';
import { streamOtlpProtobuf } from '../model/otlp-proto.js';
import type { Logger } from '../writer/ports.js';
import type { WriterSession } from '../writer/session.js';
import { serviceOf } from './signals.js';
import { type Outcome, outcomeOf } from './status.js';

export type BodyEncoding = 'json' | 'protobuf';

export interface ReceiveResult {
  accepted: number;
  rejected: number;
  errorMessage: string | null;
}

export interface Admission {
  /** Bytes claimed so far. */
  readonly bytes: number;
  /** Claim `more` bytes; false (and nothing claimed) when that would exceed the budget while another admission is open. */
  grow(more: number): boolean;
  /** Give the bytes back. Idempotent. */
  release(): void;
}

export interface ReceiverStats {
  /** Every request that reached the receiver, refused ones included. */
  requests: number;
  /** Body bytes of the requests taken on for processing (not those refused before or at admission). */
  bytes: number;
  /** Records written, per signal. */
  accepted: Record<OtlpSignal, number>;
  /** Records dropped inside requests that were otherwise answered 200 (a partial success), per signal. */
  rejected: Record<OtlpSignal, number>;
  /** Requests that failed, by outcome: refused by a transport before decoding, or failed inside `receive`. */
  refused: Record<Outcome, number>;
}

export interface ReceiverOptions {
  inflightBudgetBytes: number;
}

export interface Receiver {
  /**
   * Claim `bytes` of the in-flight budget before buffering a body. Null when it would exceed the budget while another
   * admission is open (the transport counts that refusal with `refused`). A single request is always admitted when
   * nothing else is.
   */
  admit(bytes: number): Admission | null;
  /** `transport` names the source: `otlp/http` or `otlp/grpc`. Releases `admission` when done, success or failure. */
  receive(
    signal: OtlpSignal,
    body: Uint8Array,
    encoding: BodyEncoding,
    transport: string,
    admission: Admission,
  ): Promise<ReceiveResult>;
  /** A transport refused a request before it reached `receive` (a bad path, method, content type or body). */
  refused(outcome: Outcome, reason: string): void;
  stats(): ReceiverStats;
  /** Stop accepting (later receives fail `receiver-busy`), wait for the receives in progress. Idempotent. */
  close(): Promise<void>;
}

const ROOT_KEY: Readonly<Record<OtlpSignal, string>> = {
  traces: 'resourceSpans',
  logs: 'resourceLogs',
  metrics: 'resourceMetrics',
};

function noRefusals(): Record<Outcome, number> {
  return {
    invalid: 0,
    'too-large': 0,
    unsupported: 0,
    'not-found': 0,
    method: 0,
    busy: 0,
    internal: 0,
  };
}

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
    if (e instanceof OtelHtmlError && e.path === NO_SIGNAL_PATH) return [];
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
): OtlpRequest[] {
  switch (encoding) {
    case 'json':
      return jsonEntries(signal, body, source);
    case 'protobuf':
      return [...streamOtlpProtobuf(body, signal, source)];
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
  const totals: ReceiverStats = {
    requests: 0,
    bytes: 0,
    accepted: perSignal(),
    rejected: perSignal(),
    refused: noRefusals(),
  };
  const warned = new Set<Outcome>();

  /** Counts a failed request; the first of each kind is warned about, so a misconfigured exporter shows up. */
  function refuse(outcome: Outcome, reason: string): void {
    totals.refused[outcome]++;
    if (warned.has(outcome)) return;
    warned.add(outcome);
    logger.warn(
      `receiver refused a request (${outcome}); further ones of this kind are counted, not logged`,
      {
        reason,
      },
    );
  }

  /** Body bytes claimed by the open admissions. */
  let inflightBytes = 0;
  const openAdmissions = new Set<Admission>();
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
          if (records > 0) {
            await session.add(entry, source, { partial: true });
            acceptedEntries++;
          }
          accepted += records;
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
    totals.accepted[signal] += accepted;
    if (failure !== null) throw failure.error;
    totals.rejected[signal] += rejected;
    if (rejectedEntries > 0 && acceptedEntries === 0) {
      throw new OtelHtmlError('invalid-otlp', {
        message: errorMessage ?? `${source}: every entry was rejected`,
      });
    }
    return { accepted, rejected, errorMessage };
  }

  /** The budget is only enforced while another admission is open: a lone request is always admitted. */
  function fits(more: number, others: number): boolean {
    return others === 0 || inflightBytes + more <= options.inflightBudgetBytes;
  }

  return {
    admit(bytes) {
      if (!fits(bytes, openAdmissions.size)) return null;
      let claimed = bytes;
      inflightBytes += bytes;
      totals.bytes += bytes;
      const admission: Admission = {
        get bytes() {
          return claimed;
        },
        grow(more) {
          if (!openAdmissions.has(admission)) return false;
          if (!fits(more, openAdmissions.size - 1)) return false;
          claimed += more;
          inflightBytes += more;
          totals.bytes += more;
          return true;
        },
        release() {
          if (!openAdmissions.delete(admission)) return;
          inflightBytes -= claimed;
        },
      };
      openAdmissions.add(admission);
      return admission;
    },
    async receive(signal, body, encoding, transport, admission) {
      totals.requests++;
      try {
        if (closed) throw new OtelHtmlError('receiver-busy', { message: 'receiver is closing' });
        const run = tail.then(() => process(signal, body, encoding, transport));
        tail = run.catch(() => undefined);
        return await run;
      } catch (e) {
        refuse(outcomeOf(e), e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        admission.release();
      }
    },
    refused(outcome, reason) {
      totals.requests++;
      refuse(outcome, reason);
    },
    stats: () => ({
      requests: totals.requests,
      bytes: totals.bytes,
      accepted: { ...totals.accepted },
      rejected: { ...totals.rejected },
      refused: { ...totals.refused },
    }),
    async close() {
      closed = true;
      await tail;
    },
  };
}

import { OtelHtmlError } from '../model/errors.js';

export type Outcome = 'invalid' | 'too-large' | 'unsupported' | 'not-found' | 'method' | 'busy' | 'internal';

export interface OutcomeStatus {
  readonly http: number;
  /** The gRPC status code, or null for outcomes only the HTTP transport can produce. */
  readonly grpc: number | null;
  readonly retryable: boolean;
}

export const OUTCOME_STATUS: Readonly<Record<Outcome, OutcomeStatus>> = {
  invalid: { http: 400, grpc: 3, retryable: false },
  'too-large': { http: 413, grpc: 8, retryable: false },
  unsupported: { http: 415, grpc: null, retryable: false },
  'not-found': { http: 404, grpc: null, retryable: false },
  method: { http: 405, grpc: null, retryable: false },
  busy: { http: 503, grpc: 14, retryable: true },
  internal: { http: 500, grpc: 13, retryable: false },
};

/** Seconds a client is told to wait before retrying a `busy` outcome (`Retry-After`). */
export const RETRY_AFTER_SECONDS = 1;

/** Thrown by a transport for an outcome that is its own: the request was refused before or outside OTLP decoding. */
export class ReceiverRejected extends Error {
  readonly outcome: Outcome;

  constructor(outcome: Outcome, message: string) {
    super(message);
    this.name = 'ReceiverRejected';
    this.outcome = outcome;
  }
}

/** The outcome of an error thrown while receiving. */
export function outcomeOf(e: unknown): Outcome {
  if (e instanceof ReceiverRejected) return e.outcome;
  if (e instanceof OtelHtmlError) {
    switch (e.code) {
      case 'receiver-busy':
        return 'busy';
      case 'invalid-otlp':
      case 'time-out-of-range':
        return 'invalid';
      case 'unsupported-input':
        return 'unsupported';
      case 'invalid-config':
      case 'invalid-ottl':
      case 'report-locked':
      case 'version-mismatch':
      case 'invalid-report':
      case 'usage':
      case 'receiver-bind':
        return 'internal';
    }
  }
  return 'internal';
}

/** What a client is told: the typed message, or a fixed `internal error` (never a stack or an unexpected message). */
export function statusMessage(e: unknown): string {
  return e instanceof OtelHtmlError || e instanceof ReceiverRejected ? e.message : 'internal error';
}

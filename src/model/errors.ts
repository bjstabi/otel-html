export type ErrorCode =
  | 'invalid-otlp'
  | 'invalid-config'
  | 'invalid-ottl'
  | 'time-out-of-range'
  | 'report-locked'
  | 'version-mismatch'
  | 'invalid-report'
  | 'unsupported-input'
  | 'usage';

export interface ErrorDetails {
  path?: string;
  expected?: string;
  actual?: string;
  hint?: string;
  message?: string;
}

function formatMessage(d: ErrorDetails): string {
  let msg = d.message;
  if (msg === undefined) {
    const where = d.path === undefined ? '' : `${d.path}: `;
    const what =
      d.expected !== undefined && d.actual !== undefined
        ? `expected ${d.expected}, got ${d.actual}`
        : d.expected !== undefined
          ? `expected ${d.expected}`
          : d.actual !== undefined
            ? `got ${d.actual}`
            : 'error';
    msg = `${where}${what}`;
  }
  return d.hint === undefined ? msg : `${msg}\n  hint: ${d.hint}`;
}

export class OtelHtmlError extends Error {
  readonly code: ErrorCode;
  readonly path: string | undefined;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, details: ErrorDetails = {}) {
    super(formatMessage(details));
    this.name = 'OtelHtmlError';
    this.code = code;
    this.path = details.path;
    this.expected = details.expected;
    this.actual = details.actual;
    this.hint = details.hint;
  }
}

export function assertNever(x: never, path: string): never {
  throw new OtelHtmlError('invalid-report', { path, expected: 'known variant', actual: JSON.stringify(x) });
}

export function invariant(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`invariant violated: ${message}`);
}

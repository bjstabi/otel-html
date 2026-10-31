import { OtelHtmlError } from '../model/errors.js';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO = /^0+$/;

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

/** Parses a W3C `traceparent` (version 00, lower-case hex, non-zero ids); anything else is a usage error. */
export function parseTraceparent(
  value: string,
  source: string = 'TRACEPARENT',
): { traceId: Uint8Array; spanId: Uint8Array; flags: number } {
  const m = TRACEPARENT.exec(value);
  const [, traceId, spanId, flags] = m ?? [];
  if (
    traceId === undefined ||
    spanId === undefined ||
    flags === undefined ||
    ALL_ZERO.test(traceId) ||
    ALL_ZERO.test(spanId)
  ) {
    throw new OtelHtmlError('usage', {
      message: `${source} is not a W3C traceparent: ${value}`,
      hint: 'the W3C form 00-<32 hex trace id>-<16 hex span id>-<2 hex flags>',
    });
  }
  return { traceId: bytesOf(traceId), spanId: bytesOf(spanId), flags: Number.parseInt(flags, 16) };
}

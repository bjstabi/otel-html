import { z } from 'zod';
import { parseTraceId, type TraceId } from '../../model/ids.js';

export const T_FORMAT: RegExp = /^(\d+)~(\d+)$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const MAX_INT64 = 2n ** 63n - 1n;

/**
 * Whether the window text has start <= end and an end within what the URL can carry: a safe integer for a window
 * relative to the epoch (format 5), an int64 for an absolute one (format 6, unix nanoseconds).
 */
export function tRange(s: string, absolute = false): boolean {
  const m = T_FORMAT.exec(s);
  if (m === null) return true; // the regex check reports the format problem
  const a = BigInt(m[1] ?? '');
  const b = BigInt(m[2] ?? '');
  return a <= b && b <= (absolute ? MAX_INT64 : MAX_SAFE);
}

const rangeMessage = (absolute: boolean): string =>
  `<start>~<end> with start <= end and values <= ${absolute ? MAX_INT64 : Number.MAX_SAFE_INTEGER}`;

/** The `<start>~<end>` window text, shared by the `t` key and the dashboard's `sel.t`; `absolute` is a format-6 report's unix nanoseconds. */
export function windowTextSchema(absolute: boolean): z.ZodType<string> {
  return z
    .string()
    .regex(T_FORMAT, '<start>~<end> in nanoseconds')
    .refine((s) => tRange(s, absolute), rangeMessage(absolute));
}

/** The `t` value for the entire run, written when the report has a default window and the person chose past it. */
export const T_ALL = 'all';

/** The `t` key: a window, or `all`. */
export function windowParamSchema(absolute: boolean): z.ZodType<string> {
  const text = windowTextSchema(absolute);
  return z.string().superRefine((s, ctx) => {
    if (s === T_ALL) return;
    const r = text.safeParse(s);
    if (!r.success) ctx.addIssue({ code: 'custom', message: r.error.issues[0]?.message ?? 'a window' });
  });
}

export const WindowParamSchema: z.ZodType<string> = windowParamSchema(false);

/** A non-zero lowercase-hex trace id, shared by the `trace` key and the dashboard's `sel.trace`. */
export const TraceIdParamSchema: z.ZodType<TraceId> = z
  .string()
  .regex(/^[0-9a-f]{32}$/, '32 lowercase hex chars')
  .refine((s) => !/^0+$/.test(s), 'a non-zero trace id')
  .transform((s): TraceId => parseTraceId(s, 'trace'));

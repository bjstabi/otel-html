import { z } from 'zod';
import { parseTraceId, type TraceId } from '../../model/ids.js';

export const T_FORMAT: RegExp = /^(\d+)~(\d+)$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function tRange(s: string): boolean {
  const m = T_FORMAT.exec(s);
  if (m === null) return true; // the regex check reports the format problem
  const a = BigInt(m[1] ?? '');
  const b = BigInt(m[2] ?? '');
  return a <= b && b <= MAX_SAFE;
}

/** The `<start>~<end>` window text, shared by the `t` key and the dashboard's `sel.t`. */
export const WindowTextSchema: z.ZodType<string> = z
  .string()
  .regex(T_FORMAT, '<start>~<end> in nanoseconds')
  .refine(tRange, `<start>~<end> with start <= end and values <= ${Number.MAX_SAFE_INTEGER}`);

/** A non-zero lowercase-hex trace id, shared by the `trace` key and the dashboard's `sel.trace`. */
export const TraceIdParamSchema: z.ZodType<TraceId> = z
  .string()
  .regex(/^[0-9a-f]{32}$/, '32 lowercase hex chars')
  .refine((s) => !/^0+$/.test(s), 'a non-zero trace id')
  .transform((s): TraceId => parseTraceId(s, 'trace'));

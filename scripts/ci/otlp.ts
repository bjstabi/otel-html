/** OTLP JSON building blocks shared by the CI report modules. */

export type AttrValue = string | number | boolean;
export type Attr = {
  key: string;
  value: { stringValue: string } | { intValue: string } | { boolValue: boolean };
};

const RESULTS: Readonly<Record<string, string>> = {
  success: 'success',
  failure: 'failure',
  cancelled: 'cancellation',
  timed_out: 'timeout',
  skipped: 'skip',
};

/** The `cicd.pipeline.*.result` semantic-convention value of a GitHub conclusion. */
export const resultOf = (conclusion: string): string => RESULTS[conclusion] ?? 'error';

/** OTLP attributes of the defined values; null and undefined are dropped. */
export function attrs(values: Record<string, AttrValue | null | undefined>): Attr[] {
  const out: Attr[] = [];
  for (const [key, v] of Object.entries(values)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') out.push({ key, value: { stringValue: v } });
    else if (typeof v === 'boolean') out.push({ key, value: { boolValue: v } });
    else out.push({ key, value: { intValue: String(v) } });
  }
  return out;
}

/** Epoch milliseconds of an API timestamp; unparsable values count as absent. */
export function ms(s: string | null | undefined): number | undefined {
  if (s === null || s === undefined) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** Nanosecond string of epoch milliseconds. */
export const ns = (t: number): string => (BigInt(t) * 1_000_000n).toString();

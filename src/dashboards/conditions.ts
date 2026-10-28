/** Joins OTTL conditions with `and`, wrapping each in parentheses; a single part is returned as is. */
export function andConditions(...parts: (string | null)[]): string | null {
  const present = parts.filter((p): p is string => p !== null && p !== '');
  if (present.length === 0) return null;
  if (present.length === 1) return present[0] ?? null;
  return present.map((p) => `(${p})`).join(' and ');
}

/** Selects one trace's records; valid for spans and for log records. */
export function traceCondition(traceId: string): string {
  return `trace_id.string == ${JSON.stringify(traceId)}`;
}

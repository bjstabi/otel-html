/** Log severity range buckets (OTel SeverityNumber ranges), in display order. */
export const LOG_SEVERITY_KEYS = ['unspecified', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogSeverityKey = (typeof LOG_SEVERITY_KEYS)[number];

export interface SeverityBand {
  /** Upper-case name; also the stem of the OTTL `SEVERITY_NUMBER_*` enum names. */
  readonly label: string;
  /** Inclusive severity-number range. */
  readonly min: number;
  readonly max: number;
}

/**
 * The one definition of the severity bands: 1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error,
 * 21-24 fatal; 0 unspecified. Rollups, filter tokens, OTTL enums and histogram series all derive from it.
 */
export const SEVERITY_BANDS: Record<LogSeverityKey, SeverityBand> = {
  unspecified: { label: 'UNSPECIFIED', min: 0, max: 0 },
  trace: { label: 'TRACE', min: 1, max: 4 },
  debug: { label: 'DEBUG', min: 5, max: 8 },
  info: { label: 'INFO', min: 9, max: 12 },
  warn: { label: 'WARN', min: 13, max: 16 },
  error: { label: 'ERROR', min: 17, max: 20 },
  fatal: { label: 'FATAL', min: 21, max: 24 },
};

const MAX_SEVERITY_NUMBER = 24;

/** Band of each severity number 0..24, built once from `SEVERITY_BANDS`: `severityKey` runs once per log. */
const BAND_OF: readonly LogSeverityKey[] = LOG_SEVERITY_KEYS.flatMap((k) =>
  Array.from({ length: SEVERITY_BANDS[k].max - SEVERITY_BANDS[k].min + 1 }, () => k),
);

export function severityKey(n: number): LogSeverityKey {
  if (!Number.isInteger(n) || n < 0 || n > MAX_SEVERITY_NUMBER)
    throw new RangeError(`severity number must be 0..${MAX_SEVERITY_NUMBER}, got ${n}`);
  return BAND_OF[n] ?? 'unspecified';
}

/** OTTL enum name of severity number `n` within `band` (`SEVERITY_NUMBER_WARN`, `..._WARN2`, ...). */
export function severityEnumName(band: LogSeverityKey, n: number): string {
  const { label, min } = SEVERITY_BANDS[band];
  return `SEVERITY_NUMBER_${label}${n === min ? '' : n - min + 1}`;
}

import { ROLLUP_GRAIN_NS } from '../../format/manifest.js';

/** Nanoseconds relative to the report epoch (same unit and range as `SpanRecord.start`). */
export interface TimeWindow {
  start: number;
  end: number;
}

/** A window (or, with none, the report's range) of at least 256 rollup grains follows the long-window rules (spec §6.3). */
export const LONG_WINDOW_NS: number = 256 * ROLLUP_GRAIN_NS;

/**
 * With a known `range`, the window is clipped to it first: a report whose whole range is shorter never changes (spec §6.3),
 * so a long explicit window on a short report is short. Without a range the window stands as given.
 */
export function isLongWindow(window: TimeWindow | null, range: TimeWindow | null): boolean {
  const w = window === null || range === null ? (window ?? range) : clip(window, range);
  return w !== null && w.end - w.start >= LONG_WINDOW_NS;
}

function clip(w: TimeWindow, range: TimeWindow): TimeWindow {
  return { start: Math.max(w.start, range.start), end: Math.min(w.end, range.end) };
}

/** A long window moved outward so both ends sit on a grain of absolute time (epoch + relative). Idempotent. */
export function alignLongWindow(window: TimeWindow, epoch: bigint): TimeWindow {
  const grain = BigInt(ROLLUP_GRAIN_NS);
  const mod = (a: bigint): bigint => ((a % grain) + grain) % grain;
  const lo = BigInt(Math.floor(window.start));
  const hi = BigInt(Math.ceil(window.end));
  const start = lo - mod(lo + epoch);
  const m = mod(hi + epoch);
  const end = m === 0n ? hi : hi + grain - m;
  return { start: Number(start), end: Number(end) };
}

const UNIT_NS: Readonly<Record<string, number>> = {
  m: 60_000_000_000,
  h: 3_600_000_000_000,
  d: 86_400_000_000_000,
};

/** A `viewer.defaultWindow` text (`90m`, `6h`, `7d`) in nanoseconds; the config schema has checked its shape. */
export function durationNs(text: string): number {
  const m = /^([1-9][0-9]*)(m|h|d)$/.exec(text);
  const unit = m === null ? undefined : UNIT_NS[m[2] ?? ''];
  if (m === null || unit === undefined) throw new RangeError(`not a duration: ${JSON.stringify(text)}`);
  return Number(m[1]) * unit;
}

/** The report's default window, anchored at the end of its range; null when there is none or it is not shorter than the range. */
export function defaultWindowOf(text: string | undefined, range: TimeWindow | null): TimeWindow | null {
  if (text === undefined || range === null) return null;
  const width = durationNs(text);
  return width >= range.end - range.start ? null : { start: range.end - width, end: range.end };
}

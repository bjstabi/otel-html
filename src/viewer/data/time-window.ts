import { ROLLUP_GRAIN_NS } from '../../format/manifest.js';

/** Nanoseconds relative to the report epoch (same unit and range as `SpanRecord.start`). */
export interface TimeWindow {
  start: number;
  end: number;
}

/** A window (or, with none, the report's range) of at least 256 rollup grains follows the long-window rules (spec §6.3). */
export const LONG_WINDOW_NS: number = 256 * ROLLUP_GRAIN_NS;

export function isLongWindow(window: TimeWindow | null, range: TimeWindow | null): boolean {
  const w = window ?? range;
  return w !== null && w.end - w.start >= LONG_WINDOW_NS;
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

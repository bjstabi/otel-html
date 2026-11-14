import { type AnyManifest, isPartitioned } from '../../format/manifest.js';
import { relTime } from './span-results.js';
import type { TimeWindow } from './time-window.js';

/**
 * The report's time range relative to its epoch (what every viewer time is): a chunk manifest stores it that way, a
 * partition manifest stores absolute int64 text. A range wider than 2^53 ns (a report of years) is rounded to the
 * nearest double, not refused.
 */
export function manifestRange(manifest: AnyManifest): TimeWindow | null {
  if (!isPartitioned(manifest)) return manifest.range;
  if (manifest.range === null) return null;
  const epoch = BigInt(manifest.epochUnixNano);
  return {
    start: relTime(BigInt(manifest.range.start) - epoch, 'range.start'),
    end: relTime(BigInt(manifest.range.end) - epoch, 'range.end'),
  };
}

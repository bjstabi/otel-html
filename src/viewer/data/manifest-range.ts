import { type AnyManifest, isV4 } from '../../format/manifest.js';
import { toNumber } from './span-results.js';
import type { TimeWindow } from './time-window.js';

/**
 * The report's time range relative to its epoch (what every viewer time is): a chunk manifest stores it that way, a
 * partition manifest stores absolute int64 text.
 */
export function manifestRange(manifest: AnyManifest): TimeWindow | null {
  if (!isV4(manifest)) return manifest.range;
  if (manifest.range === null) return null;
  const epoch = BigInt(manifest.epochUnixNano);
  return {
    start: toNumber(BigInt(manifest.range.start) - epoch, 'range.start'),
    end: toNumber(BigInt(manifest.range.end) - epoch, 'range.end'),
  };
}

import { type AnyManifest, isV4 } from '../../format/manifest.js';
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
    start: Number(BigInt(manifest.range.start) - epoch),
    end: Number(BigInt(manifest.range.end) - epoch),
  };
}

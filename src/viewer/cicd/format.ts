import type { UnixNanos } from '../../model/ids.js';
import { formatDuration } from '../../semconv/formatters.js';
import { shortTime } from '../shell/time-range.js';

export { shortTime };

/** A duration for the CI views: zero reads `0 s` (the shared formatter would say `0 ns`). */
export const durationText = (ns: number): string => (ns === 0 ? '0 s' : formatDuration(ns));

const DAY_NS = 24 * 3_600_000 * 1_000_000;

const msOf = (rel: number, epoch: UnixNanos): number => Number(epoch / 1_000_000n) + rel / 1e6;

/** A trend axis label: the date and time on two lines, the date only for buckets of a day or more. */
export function axisTime(rel: number, epoch: UnixNanos, stepNs: number, timeZone?: string): string {
  const ms = msOf(rel, epoch);
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone }).format(ms);
  if (stepNs >= DAY_NS) return date;
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone }).format(
    ms,
  );
  return `${date}\n${time}`;
}

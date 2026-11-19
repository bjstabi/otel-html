import type { UnixNanos } from '../../model/ids.js';
import { formatDuration } from '../../semconv/formatters.js';
import { niceAxis } from '../components/run-chart-format.js';
import { shortTime } from '../shell/time-range.js';

export { shortTime };

/**
 * A duration for the CI views: zero reads `0 s`, under a minute as the shared formatter, from a minute
 * `4 min 12 s`, from an hour `1 h 5 min` (whole numbers; rounded seconds carry into the minute).
 */
export function durationText(ns: number): string {
  if (ns === 0) return '0 s';
  if (ns < 0) return `-${durationText(-ns)}`;
  if (ns < 60e9) return formatDuration(ns);
  const total = Math.round(ns / 1e9);
  const tail = (n: number, unit: string): string => (n === 0 ? '' : ` ${n} ${unit}`);
  if (total < 3600) return `${Math.floor(total / 60)} min${tail(total % 60, 's')}`;
  const minutes = Math.round(total / 60);
  return `${Math.floor(minutes / 60)} h${tail(minutes % 60, 'min')}`;
}

/** The y axis for durations in ns: round steps of seconds, minutes and hours (see `niceAxis`). */
export function durationAxis(maxNs: number, maxTicks = 5): { max: number; interval: number } {
  const { max, interval } = niceAxis(maxNs / 1e9, 's', maxTicks);
  return { max: max * 1e9, interval: interval * 1e9 };
}

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

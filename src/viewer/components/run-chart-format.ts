import { formatMetricValue } from './metric-chart-option.js';

/** Seconds per unit, for the time units a duration axis understands. */
const TIME_UNIT_SECONDS: Record<string, number> = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9 };

/** Duration tick steps in seconds. Past the last, the step doubles. */
const DURATION_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 900, 1800, 3600, 7200];

/** The first 1-2-5 step (1, 2, 5, 10, 20, 50, ...) that covers `max` in at most `maxTicks` ticks. */
function stepOneTwoFive(max: number, maxTicks: number): number {
  const exp = Math.floor(Math.log10(max / maxTicks)) - 1;
  for (let k = exp; ; k++) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** k;
      if (Math.ceil(max / step - 1e-9) <= maxTicks) return step;
    }
  }
}

function stepDuration(seconds: number, maxTicks: number): number {
  if (seconds < 1) return stepOneTwoFive(seconds, maxTicks);
  for (const step of DURATION_STEPS) {
    if (Math.ceil(seconds / step) <= maxTicks) return step;
  }
  let step = DURATION_STEPS[DURATION_STEPS.length - 1] ?? 7200;
  while (Math.ceil(seconds / step) > maxTicks) step *= 2;
  return step;
}

const tidy = (n: number): number => Number(n.toPrecision(12));

/** A y axis from 0 with at most `maxTicks` ticks, on a step that reads well in the unit. */
export function niceAxis(
  max: number,
  unit: string,
  maxTicks: number,
): { min: 0; max: number; interval: number } {
  const factor = TIME_UNIT_SECONDS[unit];
  // Work in seconds for durations, then convert back so the axis stays in the data's unit.
  const scale = factor ?? 1;
  const value = max > 0 ? max * scale : scale;
  const step = factor === undefined ? stepOneTwoFive(value, maxTicks) : stepDuration(value, maxTicks);
  const interval = tidy(step / scale);
  return { min: 0, max: tidy(Math.ceil(value / step - 1e-9) * interval), interval };
}

/** A y tick: durations read `30s`, `5m`, `1h 30m`; other units go through `formatMetricValue`. */
export function formatTick(value: number, unit: string): string {
  const factor = TIME_UNIT_SECONDS[unit];
  if (factor === undefined) return formatMetricValue(unit, value);
  const seconds = value * factor;
  if (seconds === 0) return '0s';
  if (seconds < 1) return formatMetricValue(unit, value);
  const total = Math.round(seconds);
  const parts: string[] = [];
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  return parts.join(' ');
}

/** `binary (ubuntu-24.04-arm, linux-arm64)` becomes `binary linux-arm64`: the head plus the last part in the parentheses. */
export function shortLabel(label: string): string {
  const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(label);
  if (!match) return label;
  const last = (match[2] ?? '').split(',').pop()?.trim() ?? '';
  return [match[1]?.trim(), last].filter(Boolean).join(' ');
}

/** A run's local date and time in the browser's locale; `timeZone` is for tests. */
export function runDateTime(
  epochUnixNano: string,
  relNanos: number,
  timeZone?: string,
): { date: string; time: string } {
  const ms = Number(BigInt(epochUnixNano) / 1_000_000n) + relNanos / 1e6;
  return {
    date: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone }).format(ms),
    time: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone }).format(ms),
  };
}

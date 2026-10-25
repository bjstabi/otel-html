import type { RelNanos, UnixNanos } from '../model/ids.js';

/** Round to 3 significant digits and drop trailing zeros. */
function sig3(x: number): number {
  return Number(x.toPrecision(3));
}

const DURATION_UNITS: readonly { readonly unit: string; readonly ns: number }[] = [
  { unit: 'ns', ns: 1 },
  { unit: 'µs', ns: 1e3 },
  { unit: 'ms', ns: 1e6 },
  { unit: 's', ns: 1e9 },
];

/** `1_240_000_000` -> `"1.24 s"`, `312_000_000` -> `"312 ms"`, `84_000` -> `"84 µs"`. Three significant digits. */
export function formatDuration(ns: number): string {
  if (!Number.isFinite(ns)) return String(ns);
  if (ns < 0) return `-${formatDuration(-ns)}`;
  let i = DURATION_UNITS.length - 1;
  while (i > 0 && ns < (DURATION_UNITS[i]?.ns ?? 0)) i--;
  let u = DURATION_UNITS[i];
  let value = u === undefined ? ns : sig3(ns / u.ns);
  // 999.6 ms rounds to 1000: carry into the next unit.
  const next = DURATION_UNITS[i + 1];
  if (value >= 1000 && next !== undefined) {
    u = next;
    value = sig3(ns / next.ns);
  }
  return `${value} ${u?.unit ?? 'ns'}`;
}

/** UTC wall-clock time with millisecond precision, e.g. `2023-11-14T22:13:20.001Z`. */
export function formatTime(rel: RelNanos, epoch: UnixNanos): string {
  const totalNs = BigInt(rel) + epoch;
  const ms = totalNs / 1_000_000n;
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? `${totalNs} ns` : d.toISOString();
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** Binary-prefixed size: `512 B`, `1.5 KiB`. Three significant digits. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  if (bytes < 0) return `-${formatBytes(-bytes)}`;
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  let r = i === 0 ? Math.round(v) : sig3(v);
  if (r >= 1024 && i < BYTE_UNITS.length - 1) {
    r = sig3(r / 1024);
    i++;
  }
  return `${r} ${BYTE_UNITS[i] ?? 'B'}`;
}

export const FORMATTERS: {
  readonly formatDuration: typeof formatDuration;
  readonly formatTime: typeof formatTime;
  readonly formatBytes: typeof formatBytes;
} = { formatDuration, formatTime, formatBytes };

import { ChevronLeft, ChevronRight, ZoomOut } from 'lucide-react';
import type { JSX } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { parseUnixNanos, type RelNanos, type UnixNanos } from '../../model/ids.js';
import { formatTime } from '../../semconv/formatters.js';
import type { TimeWindow } from '../data/span-query.js';
import { useSelection } from '../state/selection-context.js';
import { Tip } from './tip.js';

type Range = NonNullable<Manifest['range']>;

const MINUTE_NS = 60_000_000_000;

export interface Preset {
  label: string;
  /** Window width in nanoseconds; null is the entire run. */
  widthNs: number | null;
}
export const PRESETS: readonly Preset[] = [
  { label: 'Entire run', widthNs: null },
  { label: '15m', widthNs: 15 * MINUTE_NS },
  { label: '1h', widthNs: 60 * MINUTE_NS },
];

/** Run-relative nanoseconds as an absolute UTC time. */
export function absoluteTime(rel: number, epoch: UnixNanos): string {
  return formatTime(rel as RelNanos, epoch);
}

/** The preset window anchored at the run end; the whole run when the run is shorter than the preset. */
export function presetWindow(range: Range, widthNs: number | null): TimeWindow | null {
  if (widthNs === null || range.end - range.start <= widthNs) return null;
  return { start: range.end - widthNs, end: range.end };
}

/** Shift by exactly one window width; null when that would leave the run (so the control is disabled). */
export function stepWindow(w: TimeWindow, range: Range, dir: -1 | 1): TimeWindow | null {
  const width = w.end - w.start;
  const next = { start: w.start + dir * width, end: w.end + dir * width };
  if (dir < 0 ? next.start < range.start : w.start >= range.end) return null;
  return next;
}

/** Double the width around the centre, kept inside the run; the whole run once it no longer fits. */
export function zoomOutWindow(w: TimeWindow, range: Range): TimeWindow | null {
  const width = w.end - w.start;
  if (width * 2 >= range.end - range.start) return null;
  const start = Math.round(Math.min(Math.max(w.start - width / 2, range.start), range.end - width * 2));
  return { start, end: start + width * 2 };
}

function activePreset(w: TimeWindow | null, range: Range): string | null {
  if (w === null) return 'Entire run';
  const hit = PRESETS.find((p) => p.widthNs !== null && w.end === range.end && w.end - w.start === p.widthNs);
  return hit?.label ?? null;
}

const BUTTON =
  'rounded-full p-1.5 text-ink-2 hover:bg-hairline disabled:opacity-40 disabled:hover:bg-transparent';

export function TimeRange({ manifest }: { manifest: Manifest }): JSX.Element {
  const window = useSelection((s) => s.window);
  const setWindow = useSelection((s) => s.setWindow);
  const range = manifest.range;
  if (range === null) {
    return (
      <output aria-label="Absolute range" className="text-sm text-muted">
        No time range: the run has no data yet
      </output>
    );
  }
  const epoch = parseUnixNanos(manifest.epochUnixNano, 'manifest.epochUnixNano');
  const shown = window ?? range;
  const active = activePreset(window, range);
  const prev = window === null ? null : stepWindow(window, range, -1);
  const next = window === null ? null : stepWindow(window, range, 1);
  const zoomed = window === null ? null : zoomOutWindow(window, range);
  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="sr-only">Time range</legend>
      <div className="flex gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={active === p.label}
            onClick={() => setWindow(presetWindow(range, p.widthNs))}
            className={`rounded-full px-3 py-1 text-sm ${active === p.label ? 'bg-ink text-page font-medium' : 'text-ink-2 hover:bg-hairline'}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <Tip label="Previous window">
        <button
          type="button"
          aria-label="Previous window"
          disabled={prev === null}
          onClick={() => prev !== null && setWindow(prev)}
          className={BUTTON}
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
      </Tip>
      <Tip label="Next window">
        <button
          type="button"
          aria-label="Next window"
          disabled={next === null}
          onClick={() => next !== null && setWindow(next)}
          className={BUTTON}
        >
          <ChevronRight size={16} aria-hidden />
        </button>
      </Tip>
      <Tip label="Zoom out ×2">
        <button
          type="button"
          aria-label="Zoom out"
          disabled={window === null}
          onClick={() => window !== null && setWindow(zoomed)}
          className={BUTTON}
        >
          <ZoomOut size={16} aria-hidden />
        </button>
      </Tip>
      <output aria-label="Absolute range" className="font-mono text-xs tabular-nums text-ink-2">
        {absoluteTime(shown.start, epoch)} → {absoluteTime(shown.end, epoch)}
      </output>
    </fieldset>
  );
}

import { ChevronLeft, ChevronRight, ZoomOut } from 'lucide-react';
import type { JSX } from 'react';
import type { AnyManifest, Manifest } from '../../format/manifest.js';
import { parseUnixNanos, type RelNanos, type UnixNanos } from '../../model/ids.js';
import { formatTime } from '../../semconv/formatters.js';
import { manifestRange } from '../data/manifest-range.js';
import { isLongWindow, type TimeWindow } from '../data/time-window.js';
import { aligned } from '../state/selection.js';
import { useSelection } from '../state/selection-context.js';
import { Tip } from './tip.js';

type Range = NonNullable<Manifest['range']>;

const MINUTE_NS = 60_000_000_000;
const HOUR_NS = 60 * MINUTE_NS;

interface Preset {
  label: string;
  /** Window width in nanoseconds; null is the entire run. */
  widthNs: number | null;
}
const PRESETS: readonly Preset[] = [
  { label: 'Entire run', widthNs: null },
  { label: '15m', widthNs: 15 * MINUTE_NS },
  { label: '1h', widthNs: HOUR_NS },
  { label: '6h', widthNs: 6 * HOUR_NS },
  { label: '24h', widthNs: 24 * HOUR_NS },
  { label: '7d', widthNs: 168 * HOUR_NS },
];

/** A preset is offered only while the run is longer than it ("Entire run" always). */
function offered(p: Preset, range: Range): boolean {
  return p.widthNs === null || range.end - range.start > p.widthNs;
}

/** Run-relative nanoseconds as an absolute UTC time. */
export function absoluteTime(rel: number, epoch: UnixNanos): string {
  return formatTime(rel as RelNanos, epoch);
}

/** The preset window anchored at the run end; the whole run when the run is shorter than the preset. */
function presetWindow(range: Range, widthNs: number | null): TimeWindow | null {
  if (widthNs === null || range.end - range.start <= widthNs) return null;
  return { start: range.end - widthNs, end: range.end };
}

/** Shift by exactly one window width; null when the result would leave the run in either direction (the control is then disabled, never clamped). */
export function stepWindow(w: TimeWindow, range: Range, dir: -1 | 1): TimeWindow | null {
  const width = w.end - w.start;
  const next = { start: w.start + dir * width, end: w.end + dir * width };
  if (next.start < range.start || next.end > range.end) return null;
  return next;
}

/** Double the width around the centre, kept inside the run; the whole run once it no longer fits. */
function zoomOutWindow(w: TimeWindow, range: Range): TimeWindow | null {
  const width = w.end - w.start;
  if (width * 2 >= range.end - range.start) return null;
  const start = Math.round(Math.min(Math.max(w.start - width / 2, range.start), range.end - width * 2));
  return { start, end: start + width * 2 };
}

/** The preset the window is, as the selection holds it: a long preset sits on absolute grains, so compare after alignment. */
function activePreset(w: TimeWindow | null, range: Range, epoch: bigint): string | null {
  if (w === null) return 'Entire run';
  const hit = PRESETS.find((p) => {
    if (p.widthNs === null || !offered(p, range)) return false;
    const e = aligned(presetWindow(range, p.widthNs), epoch, () => range);
    return e !== null && e.start === w.start && e.end === w.end;
  });
  return hit?.label ?? null;
}

/** Said wherever a percentile is read from the duration buckets (spec 6.3, decision 15). */
export const APPROXIMATE_TITLE = 'Percentiles over windows of 4 h 40 min or longer are within about 5 %.';

const BUTTON =
  'rounded-full p-1.5 text-ink-2 hover:bg-hairline disabled:opacity-40 disabled:hover:bg-transparent';

export function TimeRange({ manifest }: { manifest: AnyManifest }): JSX.Element {
  const win = useSelection((s) => s.window);
  const setWindow = useSelection((s) => s.setWindow);
  const range = manifestRange(manifest);
  if (range === null) {
    return (
      <output aria-label="Absolute range" className="text-sm text-muted">
        No time range: the run has no data yet
      </output>
    );
  }
  const epoch = parseUnixNanos(manifest.epochUnixNano, 'manifest.epochUnixNano');
  const shown = win ?? range;
  const active = activePreset(win, range, BigInt(manifest.epochUnixNano));
  const prev = win === null ? null : stepWindow(win, range, -1);
  const next = win === null ? null : stepWindow(win, range, 1);
  const zoomed = win === null ? null : zoomOutWindow(win, range);
  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="sr-only">Time range</legend>
      <div className="flex gap-1">
        {PRESETS.filter((p) => offered(p, range)).map((p) => (
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
          disabled={win === null}
          onClick={() => win !== null && setWindow(zoomed)}
          className={BUTTON}
        >
          <ZoomOut size={16} aria-hidden />
        </button>
      </Tip>
      <output aria-label="Absolute range" className="font-mono text-xs tabular-nums text-ink-2">
        {absoluteTime(shown.start, epoch)} → {absoluteTime(shown.end, epoch)}
      </output>
      {isLongWindow(win, range) && (
        <span title={APPROXIMATE_TITLE} className="text-xs text-muted">
          percentiles approximate
        </span>
      )}
    </fieldset>
  );
}

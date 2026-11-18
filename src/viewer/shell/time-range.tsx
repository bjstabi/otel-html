import { Menu } from '@base-ui/react/menu';
import { ChevronDown, ChevronLeft, ChevronRight, ZoomOut } from 'lucide-react';
import { type JSX, useEffect, useRef, useState } from 'react';
import type { AnyManifest, Manifest } from '../../format/manifest.js';
import { parseUnixNanos, type RelNanos, type UnixNanos } from '../../model/ids.js';
import { formatTime } from '../../semconv/formatters.js';
import { manifestRange } from '../data/manifest-range.js';
import { isLongWindow, presetMatches, type TimeWindow } from '../data/time-window.js';
import { useSelection } from '../state/selection-context.js';
import { POPUP } from './controls.js';
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
  { label: '1h', widthNs: HOUR_NS },
  { label: '24h', widthNs: 24 * HOUR_NS },
  { label: '7d', widthNs: 168 * HOUR_NS },
  { label: '30d', widthNs: 720 * HOUR_NS },
  { label: '90d', widthNs: 2160 * HOUR_NS },
  { label: '1y', widthNs: 8760 * HOUR_NS },
];

/** A preset is offered only while the run is longer than it ("Entire run" always). */
function offered(p: Preset, range: Range): boolean {
  return p.widthNs === null || range.end - range.start > p.widthNs;
}

/** Run-relative nanoseconds as the `YYYY-MM-DDTHH:mm:ss` UTC text a datetime-local input holds. */
function toLocalInput(rel: number, epoch: bigint): string {
  const ms = Number((BigInt(Math.round(rel)) + epoch) / 1_000_000n);
  return new Date(ms).toISOString().slice(0, 19);
}

/** The inverse: a datetime-local text read as UTC, as run-relative nanoseconds; NaN when it is empty or invalid. */
function fromLocalInput(text: string, epoch: bigint): number {
  const ms = Date.parse(`${text}Z`);
  if (Number.isNaN(ms)) return Number.NaN;
  return Number(BigInt(ms) * 1_000_000n - epoch);
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
export function activePreset(
  w: TimeWindow | null,
  range: Range,
  epoch: bigint,
  floor: boolean,
): string | null {
  if (w === null) return 'Entire run';
  const hit = PRESETS.find((p) => {
    return p.widthNs !== null && presetMatches(w, p.widthNs, range, epoch, floor);
  });
  return hit?.label ?? null;
}

/** Said wherever a percentile is read from the duration buckets (spec 6.3, decision 15). */
export const APPROXIMATE_TITLE = 'Percentiles over windows of 4 h 40 min or longer are within about 5 %.';

const BUTTON =
  'rounded-full p-1.5 text-ink-2 hover:bg-hairline disabled:opacity-40 disabled:hover:bg-transparent';

function CustomRange({
  initial,
  epoch,
  lowest,
  onApply,
  onCancel,
}: {
  initial: TimeWindow;
  epoch: bigint;
  /** The earliest relative start the URL can state (0 unanchored). */
  lowest: number;
  onApply: (w: TimeWindow) => void;
  /** Escape or Cancel: close the inputs without changing the range. */
  onCancel?: () => void;
}): JSX.Element {
  const initialFrom = toLocalInput(initial.start, epoch);
  const initialTo = toLocalInput(initial.end, epoch);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  // Unedited inputs keep the original window (the inputs hold whole seconds); a start before `lowest` is clamped to it.
  const start = from === initialFrom ? initial.start : Math.max(lowest, fromLocalInput(from, epoch));
  const end = to === initialTo ? initial.end : fromLocalInput(to, epoch);
  const valid = start < end && end <= 9e18 + lowest;
  const INPUT = 'rounded border border-hairline bg-page px-1 py-0.5 text-xs font-mono text-ink-2';
  const first = useRef<HTMLInputElement>(null);
  const dismissable = onCancel !== undefined;
  useEffect(() => {
    if (dismissable) first.current?.focus();
  }, [dismissable]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is a shortcut on the group; the controls inside are the interface
    <span
      className="flex flex-wrap items-center gap-1"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onCancel !== undefined) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        ref={first}
        type="datetime-local"
        step={1}
        aria-label="Custom range from (UTC)"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        className={INPUT}
      />
      <span aria-hidden>→</span>
      <input
        type="datetime-local"
        step={1}
        aria-label="Custom range to (UTC)"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className={INPUT}
      />
      <button
        type="button"
        disabled={!valid}
        onClick={() => valid && onApply({ start, end })}
        className="rounded-full px-3 py-1 text-sm text-ink-2 hover:bg-hairline disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Apply
      </button>
      {onCancel !== undefined && (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-sm text-ink-2 hover:bg-hairline"
        >
          Cancel
        </button>
      )}
    </span>
  );
}

export function TimeRange({ manifest }: { manifest: AnyManifest }): JSX.Element {
  const [custom, setCustom] = useState(false);
  const anchor = useSelection((s) => s.anchor);
  const win = useSelection((s) => s.window);
  const setWindow = useSelection((s) => s.setWindow);
  const anchored = useSelection((s) => s.anchor !== null);
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
  const active = activePreset(win, range, BigInt(manifest.epochUnixNano), !anchored);
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
        <button
          type="button"
          aria-expanded={custom}
          onClick={() => setCustom((c) => !c)}
          className={`rounded-full px-3 py-1 text-sm ${custom ? 'bg-ink text-page font-medium' : 'text-ink-2 hover:bg-hairline'}`}
        >
          custom…
        </button>
      </div>
      {custom && (
        <CustomRange
          initial={shown}
          epoch={BigInt(manifest.epochUnixNano)}
          lowest={anchor === null ? 0 : -Number(anchor)}
          onApply={(w) => {
            setWindow(w);
            setCustom(false);
          }}
        />
      )}
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

/**
 * The page filter bar's range control: one dropdown with the presets and a custom range, in place of the shell's
 * row of buttons. `label` is the words for the current range; `zoomed` rings it.
 */
export function RangeMenu({
  manifest,
  label,
  zoomed,
  onPicked,
}: {
  manifest: AnyManifest;
  label: string;
  zoomed: boolean;
  /** Called after a preset, a custom range or a step changed the page window (the caller clears its zoom). */
  onPicked?: () => void;
}): JSX.Element | null {
  const [custom, setCustom] = useState(false);
  const anchor = useSelection((s) => s.anchor);
  const win = useSelection((s) => s.window);
  const setPageWindow = useSelection((s) => s.setWindow);
  const setWindow = (w: TimeWindow | null): void => {
    setPageWindow(w);
    onPicked?.();
  };
  const range = manifestRange(manifest);
  if (range === null) return null;
  const epoch = BigInt(manifest.epochUnixNano);
  const prev = win === null ? null : stepWindow(win, range, -1);
  const next = win === null ? null : stepWindow(win, range, 1);
  const wider = win === null ? null : zoomOutWindow(win, range);
  const item = 'rounded-md px-3 py-1.5 text-sm data-[highlighted]:bg-hairline';
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Menu.Root>
        <Menu.Trigger
          aria-label="Time range"
          className={`flex items-center gap-1 rounded-full border bg-surface px-3 py-1 text-sm text-ink-2 hover:bg-hairline ${zoomed ? 'border-accent ring-1 ring-accent' : 'border-hairline'}`}
        >
          {label}
          <ChevronDown size={14} aria-hidden />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="start" className="z-20">
            <Menu.Popup className={POPUP}>
              {PRESETS.filter((p) => offered(p, range)).map((p) => (
                <Menu.Item
                  key={p.label}
                  className={item}
                  onClick={() => setWindow(presetWindow(range, p.widthNs))}
                >
                  {p.label}
                </Menu.Item>
              ))}
              <Menu.Item className={item} onClick={() => setCustom(true)}>
                custom…
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {custom && (
        <CustomRange
          initial={win ?? range}
          epoch={epoch}
          lowest={anchor === null ? 0 : -Number(anchor)}
          onApply={(w) => {
            setWindow(w);
            setCustom(false);
          }}
          onCancel={() => setCustom(false)}
        />
      )}
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
          onClick={() => win !== null && setWindow(wider)}
          className={BUTTON}
        >
          <ZoomOut size={16} aria-hidden />
        </button>
      </Tip>
      {isLongWindow(win, range) && (
        <span title={APPROXIMATE_TITLE} className="text-xs text-muted">
          percentiles approximate
        </span>
      )}
    </span>
  );
}

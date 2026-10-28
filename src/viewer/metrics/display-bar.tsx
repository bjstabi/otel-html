import type { JSX } from 'react';
import { METRIC_DISPLAYS, METRIC_SCALES, type MetricPageState } from '../../query/metric-query.js';

type Display = MetricPageState['display'];
type Scale = MetricPageState['scale'];

const DISPLAY_LABEL: Record<Display, string> = {
  lines: 'Lines',
  area: 'Area',
  bars: 'Bars',
  heatmap: 'Heatmap',
  distribution: 'Distribution',
};
/** Built from bucket counts, so only a histogram query can draw them. */
const HISTOGRAM_ONLY: ReadonlySet<Display> = new Set(['heatmap', 'distribution']);
export const HEATMAP_DISABLED = 'needs a visible histogram query';
export const MIXED_UNITS_NOTE = 'different units: one chart per query';

function Switch(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  title?: string | undefined;
  onChange(v: boolean): void;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-muted">{props.label}</span>
      <button
        type="button"
        role="switch"
        aria-label={props.label}
        aria-checked={props.checked}
        disabled={props.disabled}
        title={props.title}
        onClick={() => props.onChange(!props.checked)}
        className={`relative h-3.5 w-6.5 rounded-full disabled:opacity-60 ${props.checked ? 'bg-accent' : 'bg-hairline'}`}
      >
        <span
          aria-hidden
          className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-surface ${props.checked ? 'left-3.5' : 'left-0.5'}`}
        />
      </button>
    </span>
  );
}

/** Display, Y-axis, Exemplars and One chart per query (mockup 04, screen 1). */
export function DisplayBar(props: {
  /** The display drawn (Lines when the stored one needs a histogram and none is visible). */
  display: Display;
  scale: Scale;
  exemplars: boolean;
  split: boolean;
  /** Queries with different units: one chart per query regardless of the toggle. */
  mixedUnits: boolean;
  histogramVisible: boolean;
  onDisplay(d: Display): void;
  onScale(s: Scale): void;
  onExemplars(v: boolean): void;
  onSplit(v: boolean): void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm text-ink-2">
      <fieldset className="inline-flex items-center gap-1">
        <legend className="sr-only">Display</legend>
        <span className="mr-1 text-muted">Display</span>
        {METRIC_DISPLAYS.map((d) => {
          const disabled = HISTOGRAM_ONLY.has(d) && !props.histogramVisible;
          return (
            <button
              key={d}
              type="button"
              aria-pressed={props.display === d}
              disabled={disabled}
              title={disabled ? HEATMAP_DISABLED : undefined}
              onClick={() => props.onDisplay(d)}
              className="rounded-md px-2.5 py-1 aria-pressed:bg-ink aria-pressed:text-page disabled:opacity-40"
            >
              {DISPLAY_LABEL[d]}
            </button>
          );
        })}
      </fieldset>
      <label className="inline-flex items-center gap-2">
        <span className="text-muted">Y-axis</span>
        <select
          aria-label="Y-axis"
          value={props.scale}
          onChange={(e) => {
            const s = METRIC_SCALES.find((x) => x === e.target.value);
            if (s !== undefined) props.onScale(s);
          }}
          className="rounded-md border border-hairline bg-surface px-1 py-0.5"
        >
          {METRIC_SCALES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <Switch label="Exemplars" checked={props.exemplars} onChange={props.onExemplars} />
      <Switch
        label="One chart per query"
        checked={props.split || props.mixedUnits}
        disabled={props.mixedUnits}
        title={props.mixedUnits ? MIXED_UNITS_NOTE : undefined}
        onChange={props.onSplit}
      />
      {props.mixedUnits && <output className="text-xs text-muted">{MIXED_UNITS_NOTE}</output>}
    </div>
  );
}

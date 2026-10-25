import { ChevronDown, ChevronRight } from 'lucide-react';
import { type JSX, useState } from 'react';
import { ExpHistogram } from '../../rollups/exp-histogram.js';
import type { RedSeries } from '../../rollups/red.js';
import { formatDuration } from '../../semconv/formatters.js';
import { Sparkline } from './sparkline.js';
import type { Measure } from './views.js';

export interface RedSummary {
  requests: number;
  errors: number;
  /** Errors over requests, 0 when there are no requests. */
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Totals and latency percentiles over every bucket of the series (histograms are merged, not averaged). */
export function redSummary(red: RedSeries): RedSummary {
  const requests = sum(red.counts);
  const errors = sum(red.errors);
  const merged = new ExpHistogram();
  for (const h of red.histograms) if (h !== undefined) merged.merge(h);
  const q = (p: number): number => (merged.count === 0 ? 0 : merged.quantile(p));
  return {
    requests,
    errors,
    errorRate: requests === 0 ? 0 : errors / requests,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: merged.max,
  };
}

function Stat(props: { label: string; value: string; critical?: boolean }): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{props.label}</dt>
      <dd
        className={`font-mono text-lg tabular-nums ${props.critical === true ? 'text-critical' : 'text-ink'}`}
      >
        {props.value}
      </dd>
    </div>
  );
}

function Analyze(props: { measure: Measure; onAnalyze(m: Measure): void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => props.onAnalyze(props.measure)}
      aria-label={`Analyze ${props.measure}`}
      className="rounded-full border border-hairline px-2.5 py-0.5 text-xs text-ink-2 hover:bg-hairline"
    >
      Analyze
    </button>
  );
}

/** Requests / Errors / Latency for the filtered set; collapsible, with Analyze shortcuts into the time series. */
export function RedStrip(props: { red: RedSeries; onAnalyze(measure: Measure): void }): JSX.Element {
  const [open, setOpen] = useState(true);
  const s = redSummary(props.red);
  return (
    <section
      aria-label="Requests, errors and latency"
      className="rounded-card border border-hairline bg-surface p-3"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-sm font-semibold"
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        Requests, errors and latency
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex items-end gap-3">
            <dl>
              <Stat label="Requests" value={String(s.requests)} />
            </dl>
            <Sparkline values={props.red.counts} />
            <Analyze measure="requests" onAnalyze={props.onAnalyze} />
          </div>
          <div className="flex items-end gap-3">
            <dl>
              <Stat
                label="Errors"
                value={`${s.errors} (${(s.errorRate * 100).toFixed(s.errorRate > 0 && s.errorRate < 0.01 ? 2 : 1)}%)`}
                critical={s.errors > 0}
              />
            </dl>
            <Sparkline values={props.red.errors} />
            <Analyze measure="errors" onAnalyze={props.onAnalyze} />
          </div>
          <div className="flex items-end gap-3">
            <dl className="grid grid-cols-4 gap-3">
              <Stat label="p50" value={formatDuration(s.p50)} />
              <Stat label="p95" value={formatDuration(s.p95)} />
              <Stat label="p99" value={formatDuration(s.p99)} />
              <Stat label="max" value={formatDuration(s.max)} />
            </dl>
            <Analyze measure="latency" onAnalyze={props.onAnalyze} />
          </div>
        </div>
      )}
    </section>
  );
}

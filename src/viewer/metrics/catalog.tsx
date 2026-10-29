import { type JSX, useDeferredValue, useMemo, useState } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { parseUnixNanos } from '../../model/ids.js';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import { ErrorCard } from '../components/explorer-states.js';
import { ResultsTable } from '../components/results-table.js';
import { catalogOf, type DataSource } from '../data/data-source.js';
import { metricTypeLabel } from '../data/metric-tables.js';
import { useGoTo } from '../shell/go-to.js';
import { PageChrome } from '../shell/page-chrome.js';
import { defaultMetricState } from '../state/metric-state.js';
import { useKeyedAsync } from '../state/use-keyed-async.js';
import type { ColumnUi } from '../traces/columns.js';
import { Sparkline } from '../traces/sparkline.js';

const BADGE = 'rounded-full border border-hairline px-2 py-0.5 text-xs text-ink-2';
const SHOWN_ATTRIBUTES = 2;
const TABLE_HEIGHT = 560;

/** First `limit` items, then `+N` for the rest. */
function firstAndMore(items: readonly string[], limit: number): string {
  if (items.length === 0) return '-';
  const rest = items.length - limit;
  return rest > 0 ? `${items.slice(0, limit).join(', ')} +${rest}` : items.join(', ');
}

/** The series column: the series kept, and `+ other` when more series than the cap folded into one. */
function seriesLabel(e: MetricEntry): string {
  // `series` counts the `other` series itself, which `folded` (a count of points) says exists.
  return e.folded > 0 ? `${e.series - 1} + other` : String(e.series);
}

/** The sparkline's values: the mean of each bucket, 0 for an empty one. */
function sparkValues(e: MetricEntry): number[] {
  const { sums, counts } = e.spark.toJSON();
  return counts.map((n, i) => (n === 0 ? 0 : (sums[i] ?? 0) / n));
}

function matches(e: MetricEntry, needle: string): boolean {
  return [e.name, e.unit, ...e.scopes].some((s) => s.toLowerCase().includes(needle));
}

const COLUMNS: readonly ColumnUi<MetricEntry>[] = [
  {
    id: 'metric',
    header: 'Metric',
    width: 280,
    mono: true,
    cell: (e) => (
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="truncate" title={e.name}>
          {e.name}
        </span>
        {e.conflicting && <span className={BADGE}>2 definitions</span>}
        {e.resets > 0 && (
          <span className={BADGE}>
            {e.resets} {e.resets === 1 ? 'reset' : 'resets'}
          </span>
        )}
        {e.noValue > 0 && <span className={BADGE}>{e.noValue} without a value</span>}
      </span>
    ),
  },
  {
    id: 'type',
    header: 'Type',
    width: 130,
    cell: (e) => <span className={BADGE}>{metricTypeLabel(e)}</span>,
  },
  { id: 'unit', header: 'Unit', width: 70, mono: true, cell: (e) => e.unit || '-' },
  { id: 'temporality', header: 'Temporality', width: 100, cell: (e) => e.temporality },
  { id: 'scope', header: 'Scope', width: 140, mono: true, cell: (e) => firstAndMore(e.scopes, 1) },
  {
    id: 'attributes',
    header: 'Attributes',
    width: 200,
    mono: true,
    cell: (e) => firstAndMore(e.attributeKeys, SHOWN_ATTRIBUTES),
  },
  { id: 'series', header: 'Series', width: 100, mono: true, cell: seriesLabel },
  {
    id: 'spark',
    header: 'Over the run',
    width: 110,
    cell: (e) => <Sparkline values={sparkValues(e)} />,
  },
  { id: 'explore', header: '', width: 80, cell: () => <span className="text-accent">Explore →</span> },
];

// Module-level so it is stable: `useKeyedAsync` reloads on a new `load`, and a fresh closure per render would start a
// new load after every settled one.

function ZeroMetrics({ manifest }: { manifest: Manifest }): JSX.Element {
  return (
    <section className="max-w-xl rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-base font-semibold">This report has no metrics</h2>
      <p className="mt-1 text-sm text-ink-2">
        It does hold <span className="font-mono tabular-nums">{manifest.totals.spans}</span> spans and{' '}
        <span className="font-mono tabular-nums">{manifest.totals.logs}</span> logs.
      </p>
    </section>
  );
}

/** Mockup 04, screen 2: every metric definition in the report; a row opens the Explorer on it. */
export function MetricsCatalog(props: { dataSource: DataSource }): JSX.Element {
  const { manifest } = props.dataSource;
  const goTo = useGoTo();
  const load = useKeyedAsync(props.dataSource, catalogOf);
  const [filter, setFilter] = useState('');
  const needle = useDeferredValue(filter.trim().toLowerCase());
  const epoch = useMemo(() => parseUnixNanos(manifest.epochUnixNano, 'manifest.epochUnixNano'), [manifest]);
  const all = load.status === 'ready' ? load.value.entries() : [];
  const rows = useMemo(() => (needle === '' ? all : all.filter((e) => matches(e, needle))), [all, needle]);

  const open = (e: MetricEntry): void => {
    const state = defaultMetricState(e);
    const [first, ...rest] = state.queries;
    // Only a name with several definitions needs the kind and unit to pick one.
    const queries =
      first === undefined || !e.conflicting
        ? state.queries
        : [{ ...first, kind: e.type, unit: e.unit }, ...rest];
    goTo('metrics', '/metrics', { m: { ...state, queries } });
  };

  return (
    <PageChrome title="Metrics Catalog" manifest={manifest}>
      {manifest.totals.metrics === 0 && <ZeroMetrics manifest={manifest} />}
      {manifest.totals.metrics > 0 && load.status === 'loading' && (
        <p role="status" className="text-sm text-muted">
          Loading metrics
        </p>
      )}
      {load.status === 'error' && (
        <ErrorCard title="The metric catalog could not be loaded" message={load.message} />
      )}
      {load.status === 'ready' && all.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="mr-auto text-sm text-ink-2">
              <span className="font-mono tabular-nums">{all.length}</span> metrics ·{' '}
              <span className="font-mono tabular-nums">{load.value.scopes().length}</span> scopes
            </p>
            <input
              type="search"
              aria-label="Filter metrics"
              placeholder="Filter by name, unit or scope"
              value={filter}
              onChange={(ev) => setFilter(ev.target.value)}
              className="w-72 rounded-full border border-hairline bg-surface px-3 py-1.5 text-sm"
            />
          </div>
          <ResultsTable
            rows={rows}
            columns={COLUMNS}
            rowId={(e) => String(e.id)}
            sort={null}
            onSort={() => undefined}
            onRowClick={open}
            selectedId={null}
            epoch={epoch}
            height={TABLE_HEIGHT}
            rowHeight={44}
          />
        </div>
      )}
    </PageChrome>
  );
}

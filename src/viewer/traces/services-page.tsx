import { type JSX, useEffect, useMemo, useState } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { ExpHistogram } from '../../rollups/exp-histogram.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { SpanStatusKey } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import { formatDuration } from '../../semconv/formatters.js';
import { facetKeyToPath, tokensToOttl } from '../components/filter-tokens.js';
import type { DataSource, Landing, SpanQuery } from '../data/data-source.js';
import { PageChrome } from '../shell/page-chrome.js';
import { navigateRoute } from '../shell/use-route.js';
import { selectionToUrlState } from '../state/selection.js';
import { useSelection } from '../state/selection-context.js';
import { serializeUrlState } from '../state/url-state.js';
import { createColorAssigner } from '../theme/palette.js';
import { ServiceChip } from './columns.js';
import { Sparkline } from './sparkline.js';

const SERVICE_KEY = 'service.name';
const DURATION_KEY_SEP = '\u0000';
/** Services listed (largest first); the per-service sparkline queries are limited to these. */
const MAX_SERVICES = 50;

export interface ServiceStats {
  service: string;
  requests: number;
  errors: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * One row per service from the unfiltered rollups: request counts from the service facet, percentiles from the
 * merged per-resource duration histograms, error counts from `errorsByService`.
 */
export function serviceStats(
  facets: FacetCounts,
  durations: Landing['durations'],
  errorsByService: ReadonlyMap<string, number>,
): ServiceStats[] {
  return facets.top(SERVICE_KEY, MAX_SERVICES).map(({ value: service, count }) => {
    const merged = new ExpHistogram();
    for (const [key, h] of durations) if (key.startsWith(`${service}${DURATION_KEY_SEP}`)) merged.merge(h);
    const q = (p: number): number => (merged.count === 0 ? 0 : merged.quantile(p));
    const errors = errorsByService.get(service) ?? 0;
    return {
      service,
      requests: count,
      errors,
      errorRate: count === 0 ? 0 : errors / count,
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
    };
  });
}

const baseQuery = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 0,
  groupBy: null,
  scanAll: false,
  ...over,
});

const serviceCondition = (service: string): string | null =>
  tokensToOttl([{ key: facetKeyToPath(SERVICE_KEY, 'span', 'core'), op: '==', value: service }]);

interface Loaded {
  stats: ServiceStats[];
  series: Map<string, readonly number[]>;
}

type Load = { status: 'loading' } | { status: 'ready'; data: Loaded } | { status: 'error'; message: string };

function useServices(dataSource: DataSource): Load {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    (async (): Promise<void> => {
      const landing = await dataSource.landing();
      const errorsQuery = await dataSource.querySpans(
        baseQuery({ condition: 'status.code == STATUS_CODE_ERROR' }),
        undefined,
        signal,
      );
      const errors = new Map(
        errorsQuery.facets.top(SERVICE_KEY, MAX_SERVICES).map((t) => [t.value, t.count] as const),
      );
      const stats = serviceStats(landing.facets, landing.durations, errors);
      if (signal.aborted) return;
      const series = new Map<string, readonly number[]>();
      setLoad({ status: 'ready', data: { stats, series } });
      for (const s of stats) {
        const r = await dataSource.querySpans(
          baseQuery({ condition: serviceCondition(s.service) }),
          undefined,
          signal,
        );
        if (signal.aborted) return;
        series.set(s.service, sumKeys(r.buckets));
        setLoad({ status: 'ready', data: { stats, series: new Map(series) } });
      }
    })().catch((e: unknown) => {
      if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setLoad({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    });
    return () => controller.abort();
  }, [dataSource]);
  return load;
}

function sumKeys(b: TimeBuckets<SpanStatusKey>): number[] {
  return Array.from({ length: b.length }, (_, i) => b.keys.reduce((a, k) => a + (b.counts(k)[i] ?? 0), 0));
}

const TH = 'py-2 text-left text-xs font-semibold text-ink-2';
const NUM = 'py-2 text-right font-mono text-sm tabular-nums';

/** Per-service table from the rollups. Clicking a row opens the explorer filtered on that service. */
export function ServicesPage(props: { dataSource: DataSource }): JSX.Element {
  const load = useServices(props.dataSource);
  const selection = useSelection((s) => s);
  const colors = useMemo(() => createColorAssigner(), []);
  const manifest: Manifest = props.dataSource.manifest;

  const open = (service: string): void => {
    const condition = serviceCondition(service);
    selection.setCondition(condition);
    navigateRoute(window, '/traces', serializeUrlState(selectionToUrlState({ ...selection, condition })));
  };

  return (
    <PageChrome title="Services" manifest={manifest}>
      {load.status === 'loading' && (
        <p role="status" className="text-sm text-muted">
          Loading services
        </p>
      )}
      {load.status === 'error' && (
        <div role="alert" className="rounded-card border border-hairline bg-surface p-4">
          <p className="font-semibold text-critical">The services could not be loaded</p>
          <p className="mt-1 font-mono text-xs break-words text-ink-2">{load.message}</p>
        </div>
      )}
      {load.status === 'ready' && load.data.stats.length === 0 && (
        <p className="rounded-card border border-hairline bg-surface p-4 text-sm">This report has no spans</p>
      )}
      {load.status === 'ready' && load.data.stats.length > 0 && (
        <table className="w-full rounded-card border border-hairline bg-surface text-sm">
          <caption className="sr-only">Services</caption>
          <thead>
            <tr className="border-b border-hairline">
              <th scope="col" className={`${TH} pl-3`}>
                Service
              </th>
              {['Requests', 'Errors', 'Error rate', 'p50', 'p95', 'p99'].map((h) => (
                <th key={h} scope="col" className={`${TH} text-right`}>
                  {h}
                </th>
              ))}
              <th scope="col" className={`${TH} pl-6 pr-3`}>
                Requests over time
              </th>
            </tr>
          </thead>
          <tbody>
            {load.data.stats.map((s) => (
              <tr key={s.service} className="border-b border-hairline last:border-0 hover:bg-page">
                <th scope="row" className="py-2 pl-3 text-left font-normal">
                  <button
                    type="button"
                    onClick={() => open(s.service)}
                    className="rounded-full px-1 hover:underline"
                  >
                    <ServiceChip service={s.service} colors={colors} />
                  </button>
                </th>
                <td className={NUM}>{s.requests}</td>
                <td className={`${NUM} ${s.errors > 0 ? 'text-critical' : ''}`}>{s.errors}</td>
                <td className={`${NUM} ${s.errors > 0 ? 'text-critical' : ''}`}>
                  {(s.errorRate * 100).toFixed(1)}%
                </td>
                <td className={NUM}>{formatDuration(s.p50)}</td>
                <td className={NUM}>{formatDuration(s.p95)}</td>
                <td className={NUM}>{formatDuration(s.p99)}</td>
                <td className="py-2 pl-6 pr-3">
                  <Sparkline values={load.data.series.get(s.service) ?? []} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageChrome>
  );
}

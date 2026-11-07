import { type JSX, useEffect, useState } from 'react';
import { formatDuration } from '../../semconv/formatters.js';
import { facetKeyToPath, tokensToOttl } from '../components/filter-tokens.js';
import type { DataSource } from '../data/data-source.js';
import type { ServiceStats, ServicesResult } from '../data/results.js';
import type { TimeWindow } from '../data/time-window.js';
import { PageChrome } from '../shell/page-chrome.js';
import { navigateRoute } from '../shell/use-route.js';
import { selectionToUrlState } from '../state/selection.js';
import { useSelection } from '../state/selection-context.js';
import { serializeUrlState } from '../state/url-state.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { ServiceChip } from './columns.js';
import { ZeroSpans } from './explorer.js';
import { Sparkline } from './sparkline.js';

const SERVICE_KEY = 'service.name';
/** Services listed (busiest first). */
const MAX_SERVICES = 50;

const serviceCondition = (service: string): string | null =>
  tokensToOttl([{ key: facetKeyToPath(SERVICE_KEY, 'span', 'core'), op: '==', value: service }]);

type Load =
  | { status: 'loading' }
  | { status: 'ready'; data: ServicesResult }
  | { status: 'error'; message: string };

function useServices(dataSource: DataSource, win: TimeWindow | null): Load {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: 'loading' });
    dataSource.services({ window: win, condition: null, limit: MAX_SERVICES }, controller.signal).then(
      (data) => controller.signal.aborted || setLoad({ status: 'ready', data }),
      (e: unknown) => {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setLoad({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => controller.abort();
  }, [dataSource, win]);
  return load;
}

const requestsOver = (s: ServiceStats): number[] =>
  Array.from({ length: s.buckets.length }, (_, i) => s.buckets.counts('count')[i] ?? 0);

const TH = 'py-2 text-left text-xs font-semibold text-ink-2';
const NUM = 'py-2 text-right font-mono text-sm tabular-nums';

/** Per-service table from the rollups. Clicking a row opens the explorer filtered on that service. */
export function ServicesPage(props: { dataSource: DataSource }): JSX.Element {
  const selection = useSelection((s) => s);
  const load = useServices(props.dataSource, selection.window);
  const colors = useColorAssigner();
  const manifest = props.dataSource.manifest;

  const open = (service: string): void => {
    const condition = serviceCondition(service);
    selection.setCondition(condition);
    navigateRoute(window, '/traces', serializeUrlState(selectionToUrlState({ ...selection, condition })));
  };

  return (
    <PageChrome title="Services" signal="span" manifest={manifest}>
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
      {load.status === 'ready' &&
        load.data.services.length === 0 &&
        (manifest.totals.spans === 0 ? (
          <ZeroSpans manifest={manifest} />
        ) : (
          <p role="status" className="text-sm text-ink-2">
            No spans in the selected time range.
          </p>
        ))}
      {load.status === 'ready' && load.data.total > MAX_SERVICES && (
        <p className="mb-3 text-xs text-muted">Showing the {MAX_SERVICES} busiest services.</p>
      )}
      {load.status === 'ready' && load.data.services.length > 0 && (
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
            {load.data.services.map((s) => (
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
                  {((s.requests === 0 ? 0 : s.errors / s.requests) * 100).toFixed(1)}%
                </td>
                <td className={NUM}>{formatDuration(s.p50)}</td>
                <td className={NUM}>{formatDuration(s.p95)}</td>
                <td className={NUM}>{formatDuration(s.p99)}</td>
                <td className="py-2 pl-6 pr-3">
                  <Sparkline values={requestsOver(s)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageChrome>
  );
}

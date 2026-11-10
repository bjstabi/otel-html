import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { DataSource } from './data/data-source.js';
import type { LoadProgress, OpenedReport } from './data/open-report.js';
import { POLL_MS, type RefreshControl, readPoll, writePoll } from './shell/in-progress.js';
import { Shell } from './shell/shell.js';
import type { HistoryPort } from './state/selection.js';

type Load =
  | { status: 'loading'; progress: LoadProgress | null }
  | { status: 'ready'; dataSource: DataSource; refresh: OpenedReport['refresh'] }
  | { status: 'failed'; message: string };

/** The hint under the error: only for failures that a moved or partial report explains, not for D12 or engine errors. */
const STALE_FORMAT = /this viewer reads format 4/;

function LoadFailure({ message }: { message: string }): JSX.Element {
  return (
    <main className="mx-auto max-w-xl p-8">
      <div role="alert" className="rounded-card border border-hairline bg-surface p-6">
        <h1 className="text-xl font-semibold text-critical">This report could not be loaded</h1>
        <p className="mt-2 font-mono text-sm break-words text-ink-2">{message}</p>
        {!STALE_FORMAT.test(message) && (
          <p className="mt-3 text-sm text-muted">
            The report folder may be incomplete or moved. Open it again from its original location.
          </p>
        )}
      </div>
    </main>
  );
}

/** The loading line for each phase of `LoadProgress`. */
function progressText(p: LoadProgress | null): string {
  if (p === null) return 'Loading report';
  switch (p.phase) {
    case 'engine':
      return 'Starting the query engine';
    case 'partitions':
      return p.total === undefined || p.done === undefined
        ? 'Loading partitions'
        : `Loading partition ${Math.min(p.done + 1, p.total)} of ${p.total}`;
    case 'views':
      return 'Preparing views';
    case 'host':
      return 'Connecting to the host';
  }
}

/** `load` is the composition root's registry -> manifest -> data source chain; failures are shown, never swallowed. */
export function App(props: {
  load: (onProgress: (p: LoadProgress) => void) => Promise<OpenedReport>;
  history: HistoryPort;
}): JSX.Element {
  const { load, history } = props;
  const [state, setState] = useState<Load>({ status: 'loading', progress: null });

  useEffect(() => {
    let live = true;
    // Progress from registrations still in flight can arrive after the load failed; it must not undo the error.
    let settled = false;
    const onProgress = (progress: LoadProgress): void => {
      if (live && !settled) setState({ status: 'loading', progress });
    };
    load(onProgress).then(
      (opened) => {
        settled = true;
        if (live) setState({ status: 'ready', dataSource: opened.dataSource, refresh: opened.refresh });
        else void opened.dataSource.close().catch(() => undefined); // unmounted mid-load: release the engine
      },
      (e: unknown) => {
        settled = true;
        if (live) setState({ status: 'failed', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [load]);

  const refreshFn = state.status === 'ready' ? state.refresh : null;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // D55: the refreshed data source replaces the shown one; a failed refresh keeps the previous one and is told on the line.
  const refresh = useCallback((): void => {
    // A click or a poll tick while a refresh runs does nothing: each finished refresh re-queries every page.
    if (refreshFn === null || inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    refreshFn().then(
      (dataSource) => {
        inFlight.current = false;
        if (!live.current) return;
        setRefreshError(null);
        setRefreshing(false);
        setState((s) => (s.status === 'ready' ? { ...s, dataSource } : s));
      },
      (e: unknown) => {
        inFlight.current = false;
        if (!live.current) return;
        setRefreshError(e instanceof Error ? e.message : String(e));
        setRefreshing(false);
      },
    );
  }, [refreshFn]);
  const [poll, setPollState] = useState(readPoll);
  const setPoll = useCallback((on: boolean): void => {
    setPollState(on);
    writePoll(on);
  }, []);
  // The poll is App's, next to the in-flight guard: it survives navigation and runs on every page. It stops once the
  // report is complete (the line is gone then).
  const growing = state.status === 'ready' && !state.dataSource.manifest.complete;
  useEffect(() => {
    if (!poll || !growing || refreshFn === null) return;
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [poll, growing, refreshFn, refresh]);
  const control: RefreshControl | null =
    refreshFn === null ? null : { refresh, busy: refreshing, error: refreshError, poll, setPoll };

  switch (state.status) {
    case 'loading':
      return (
        <p role="status" className="p-8 text-sm text-muted">
          {progressText(state.progress)}
        </p>
      );
    case 'failed':
      return <LoadFailure message={state.message} />;
    case 'ready':
      return <Shell dataSource={state.dataSource} history={history} refresh={control} />;
    default: {
      const never: never = state;
      throw new Error(`unhandled load state ${JSON.stringify(never)}`);
    }
  }
}

import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { DataSource } from './data/data-source.js';
import type { LoadProgress, OpenedReport } from './data/open-report.js';
import { pendingDataSource } from './data/pending-source.js';
import { POLL_MS, type RefreshControl, readPoll, writePoll } from './shell/in-progress.js';
import { LoadingLine } from './shell/loading-line.js';
import { Shell } from './shell/shell.js';
import type { HistoryPort } from './state/selection.js';

type Load =
  | { status: 'loading'; progress: LoadProgress | null; pending: DataSource | null }
  // `dataSource` is the shown one (the pending wrapper after a first load); `real` is the engine-backed source behind it.
  | { status: 'ready'; dataSource: DataSource; real: DataSource; refresh: OpenedReport['refresh'] }
  | { status: 'failed'; message: string };

/** The hint under the error: only for failures that a moved or partial report explains, not for D12 or engine errors. */
const STALE_FORMAT = /this viewer reads formats 5 to 8/;

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

/** `load` is the composition root's registry -> manifest -> data source chain; failures are shown, never swallowed. */
export function App(props: {
  load: (onProgress: (p: LoadProgress) => void) => Promise<OpenedReport>;
  history: HistoryPort;
}): JSX.Element {
  const { load, history } = props;
  const [state, setState] = useState<Load>({ status: 'loading', progress: null, pending: null });

  useEffect(() => {
    let live = true;
    // Progress from registrations still in flight can arrive after the load failed; it must not undo the error.
    let settled = false;
    // The pending source's queries wait on this. It exists before `load` runs: the first progress (with the manifest)
    // arrives synchronously inside it.
    let settle: { resolve: (d: DataSource) => void; reject: (e: unknown) => void } = {
      resolve: () => undefined,
      reject: () => undefined,
    };
    const ready = new Promise<DataSource>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // A failed load that no page query was waiting on must not be reported as an unhandled rejection.
    ready.catch(() => undefined);
    // Made on the first progress that carries the manifest and kept here, so the state updater below only copies.
    let pending: DataSource | null = null;
    const onProgress = (progress: LoadProgress): void => {
      if (live && !settled) {
        if (pending === null && progress.manifest !== undefined)
          pending = pendingDataSource(progress.manifest, ready);
        const kept = pending;
        setState({ status: 'loading', progress, pending: kept });
      }
    };
    load(onProgress).then(
      (opened) => {
        settled = true;
        settle.resolve(opened.dataSource);
        if (live)
          // The pending source stays the shown one: `useQuery` keys on the data-source object, so swapping it for the
          // real one would abort and re-run the first queries.
          setState((s) => ({
            status: 'ready',
            dataSource: s.status === 'loading' && s.pending !== null ? s.pending : opened.dataSource,
            real: opened.dataSource,
            refresh: opened.refresh,
          }));
        else void opened.dataSource.close().catch(() => undefined); // unmounted mid-load: release the engine
      },
      (e: unknown) => {
        settled = true;
        settle.reject(e);
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
  const run = useCallback(
    (rerun: boolean): void => {
      // A click or a poll tick while a refresh runs does nothing: each finished refresh re-queries every page.
      if (refreshFn === null || inFlight.current) return;
      inFlight.current = true;
      setRefreshing(true);
      refreshFn(rerun).then(
        (dataSource) => {
          inFlight.current = false;
          if (!live.current) return;
          setRefreshError(null);
          setRefreshing(false);
          // A poll tick that finds nothing new resolves the same real source: the shown one must not change then.
          setState((s) =>
            s.status !== 'ready' || dataSource === s.real ? s : { ...s, dataSource, real: dataSource },
          );
        },
        (e: unknown) => {
          inFlight.current = false;
          if (!live.current) return;
          setRefreshError(e instanceof Error ? e.message : String(e));
          setRefreshing(false);
        },
      );
    },
    [refreshFn],
  );
  // A reader's click re-runs the current queries even when nothing new was published; a poll tick does not.
  const refresh = useCallback((): void => run(true), [run]);
  const tick = useCallback((): void => run(false), [run]);
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
    const t = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(t);
  }, [poll, growing, refreshFn, tick]);
  const control: RefreshControl | null =
    refreshFn === null ? null : { refresh, busy: refreshing, error: refreshError, poll, setPoll };

  switch (state.status) {
    case 'loading':
      return state.pending === null ? (
        <LoadingLine progress={state.progress} />
      ) : (
        <Shell
          manifest={state.pending.manifest}
          dataSource={state.pending}
          loading={state.progress}
          history={history}
          refresh={null}
        />
      );
    case 'failed':
      return <LoadFailure message={state.message} />;
    case 'ready':
      return (
        <Shell
          manifest={state.dataSource.manifest}
          dataSource={state.dataSource}
          history={history}
          refresh={control}
        />
      );
    default: {
      const never: never = state;
      throw new Error(`unhandled load state ${JSON.stringify(never)}`);
    }
  }
}

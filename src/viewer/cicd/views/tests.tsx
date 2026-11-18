import { type JSX, useEffect, useMemo, useState } from 'react';
import { parseTraceId } from '../../../model/ids.js';
import { formatDuration } from '../../../semconv/formatters.js';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { useSubtitle } from '../../dashboards/widgets/subtitle.js';
import type { DataSource } from '../../data/data-source.js';
import { pointFromClick, useRunActions } from '../run-actions.js';
import type { CiRun } from '../runs.js';
import { type SuiteFile, type TestSuite, testSuites } from '../test-suites.js';
import { useCicd } from '../use-cicd.js';
import { CicdBody } from './body.js';

const TOP_FILES = 10;
/** How many candidate runs (those with mise tasks recorded), newest first, are asked for test spans. */
const MAX_RUNS = 3;
const MS = 1e6;

const suiteCache = new WeakMap<DataSource, Map<string, Promise<TestSuite[]>>>();

/** A run's test suites, read once per trace id for a data source. */
function suitesOf(dataSource: DataSource, run: CiRun): Promise<TestSuite[]> {
  const cache = suiteCache.get(dataSource) ?? new Map<string, Promise<TestSuite[]>>();
  suiteCache.set(dataSource, cache);
  let hit = cache.get(run.traceId);
  if (hit === undefined) {
    hit = dataSource.getTrace(parseTraceId(run.traceId, 'trace')).then(testSuites);
    cache.set(run.traceId, hit);
    // A failure is not remembered: a later render asks again.
    hit.catch(() => cache.delete(run.traceId));
  }
  return hit;
}

type Found =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; run: CiRun | null; suites: TestSuite[] };

/** The newest run, within the cap, that has test spans; runs are read one after the other. */
async function latestWithTests(
  dataSource: DataSource,
  runs: readonly CiRun[],
  live: () => boolean,
): Promise<Found> {
  const newest = runs
    .filter((r) => r.ran + r.replayed > 0)
    .sort((a, b) => b.start - a.start)
    .slice(0, MAX_RUNS);
  let failed = 0;
  for (const run of newest) {
    if (!live()) break;
    try {
      const suites = await suitesOf(dataSource, run);
      if (suites.length > 0) return { status: 'ready', run, suites };
    } catch {
      failed++;
    }
  }
  return failed === newest.length && failed > 0
    ? { status: 'error' }
    : { status: 'ready', run: null, suites: [] };
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function FileRow(props: { file: SuiteFile; longest: number; open: boolean; toggle(): void }): JSX.Element {
  const { file, longest, open } = props;
  return (
    <li data-test-file={file.file} className="border-b border-hairline">
      <button
        type="button"
        aria-expanded={open}
        onClick={props.toggle}
        className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-page"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={file.file}>
          {file.file}
        </span>
        <span className="h-2 w-40 shrink-0 rounded-sm bg-hairline/40">
          <span
            className="block h-2 rounded-sm bg-accent"
            style={{ width: `${((file.ms / longest) * 100).toFixed(1)}%` }}
          />
        </span>
        <span className="w-16 shrink-0 text-right font-mono text-xs">{formatDuration(file.ms * MS)}</span>
        <span className="w-16 shrink-0 text-right text-xs text-muted">
          {plural(file.tests.length, 'test')}
        </span>
        <span className="w-20 shrink-0 text-right text-xs text-muted">
          {file.skipped > 0 ? `${file.skipped} skipped` : ''}
        </span>
      </button>
      {open && (
        <ul className="pb-1 pl-8 pr-3">
          {file.tests.map((t) => (
            <li key={`${t.name}\u0000${t.project ?? ''}`} className="flex items-center gap-3 py-0.5 text-xs">
              <span
                data-test-name
                className={`min-w-0 flex-1 truncate ${t.skipped ? 'text-muted' : ''}`}
                title={t.name}
              >
                {t.name}
              </span>
              {t.project !== null && <span className="text-muted">{t.project}</span>}
              <span className="w-16 text-right font-mono">
                {t.skipped ? 'skipped' : formatDuration(t.ms * MS)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Pills per suite of the latest run with test spans, its slowest files, a file's tests, and the skipped tests. */
export const TestsView: WidgetRenderer = ({ widget, scope, dataSource, actions: page }): JSX.Element => {
  const data = useCicd(widget, scope);
  const actions = useRunActions(widget.id);
  const [found, setFound] = useState<Found>({ status: 'loading' });
  const [picked, setPicked] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const runs = data.runs;
  useEffect(() => {
    if (data.status !== 'ready') return;
    let live = true;
    setFound({ status: 'loading' });
    latestWithTests(dataSource, runs, () => live).then((f) => {
      if (live) setFound(f);
    });
    return () => {
      live = false;
    };
  }, [dataSource, runs, data.status]);

  const suites = found.status === 'ready' ? found.suites : [];
  const suite = suites.find((s) => s.id === picked) ?? suites[0];
  const shown = useMemo(() => suite?.files.slice(0, TOP_FILES) ?? [], [suite]);
  const longest = Math.max(1, ...shown.map((f) => f.ms));
  const skipped = useMemo(
    () =>
      suite?.files.flatMap((f) =>
        f.tests.filter((t) => t.skipped).map((t) => ({ file: f.file, name: t.name })),
      ) ?? [],
    [suite],
  );
  const skippedFiles = new Set(skipped.map((s) => s.file)).size;
  useSubtitle(
    page,
    found.status === 'ready' && suite !== undefined
      ? `${plural(suite.total, 'test')} · ${suite.skipped} skipped`
      : null,
  );

  const run = found.status === 'ready' ? found.run : null;
  return (
    <>
      <CicdBody data={data}>
        {() => {
          if (found.status === 'loading') return <div className="p-3 text-sm text-muted">Loading…</div>;
          if (found.status === 'error')
            return (
              <div role="alert" className="p-3 text-sm text-critical">
                The test spans could not be read.
              </div>
            );
          if (suite === undefined || run === null)
            return <div className="p-3 text-sm text-muted">No recent run in this range has test spans.</div>;
          return (
            <div className="text-sm">
              <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-1.5">
                <button
                  type="button"
                  data-latest-run
                  title={run.title ?? `Run ${run.runId}`}
                  onClick={(e) => actions.openRun(run, pointFromClick(e))}
                  className="rounded-full border border-hairline px-2 py-0.5 text-xs text-muted hover:text-ink"
                >
                  latest run
                </button>
                {suites.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    data-suite={s.id}
                    aria-pressed={s.id === suite.id}
                    onClick={() => {
                      setPicked(s.id);
                      setOpenFile(null);
                    }}
                    className="rounded-full border border-hairline px-2 py-0.5 text-xs text-muted aria-[pressed=true]:bg-hairline aria-[pressed=true]:text-ink"
                  >
                    {s.id}
                  </button>
                ))}
              </div>
              <ul>
                {shown.map((f) => (
                  <FileRow
                    key={f.file}
                    file={f}
                    longest={longest}
                    open={openFile === f.file}
                    toggle={() => setOpenFile(openFile === f.file ? null : f.file)}
                  />
                ))}
              </ul>
              {skipped.length > 0 && (
                <details data-skipped className="px-3 py-2 text-xs">
                  <summary className="cursor-pointer text-muted">
                    {plural(skipped.length, 'skipped test')} in {plural(skippedFiles, 'file')}
                  </summary>
                  <ul className="mt-1">
                    {skipped.map((s) => (
                      <li
                        key={`${s.file}\u0000${s.name}`}
                        className="truncate"
                        title={`${s.file} › ${s.name}`}
                      >
                        <span className="font-mono text-muted">{s.file}</span> › {s.name}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        }}
      </CicdBody>
      {actions.element}
    </>
  );
};

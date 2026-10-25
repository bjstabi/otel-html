import { type JSX, useEffect, useState } from 'react';
import type { DataSource } from './data/data-source.js';
import { Shell } from './shell/shell.js';
import type { HistoryPort } from './state/selection.js';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; dataSource: DataSource }
  | { status: 'failed'; message: string };

function LoadFailure({ message }: { message: string }): JSX.Element {
  return (
    <main className="mx-auto max-w-xl p-8">
      <div role="alert" className="rounded-card border border-hairline bg-surface p-6">
        <h1 className="text-xl font-semibold text-critical">This report could not be loaded</h1>
        <p className="mt-2 font-mono text-sm break-words text-ink-2">{message}</p>
        <p className="mt-3 text-sm text-muted">
          The report folder may be incomplete or moved. Open it again from its original location.
        </p>
      </div>
    </main>
  );
}

/** `load` is the composition root's registry -> manifest -> data source chain; failures are shown, never swallowed. */
export function App(props: { load: () => Promise<DataSource>; history: HistoryPort }): JSX.Element {
  const { load, history } = props;
  const [state, setState] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    load().then(
      (dataSource) => live && setState({ status: 'ready', dataSource }),
      (e: unknown) =>
        live && setState({ status: 'failed', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [load]);

  switch (state.status) {
    case 'loading':
      return (
        <p role="status" className="p-8 text-sm text-muted">
          Loading report
        </p>
      );
    case 'failed':
      return <LoadFailure message={state.message} />;
    case 'ready':
      return <Shell dataSource={state.dataSource} history={history} />;
    default: {
      const never: never = state;
      throw new Error(`unhandled load state ${JSON.stringify(never)}`);
    }
  }
}

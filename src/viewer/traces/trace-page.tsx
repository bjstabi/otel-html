import type { JSX } from 'react';
import { OtelHtmlError } from '../../model/errors.js';
import { parseTraceId } from '../../model/ids.js';
import type { DataSource } from '../data/data-source.js';
import { navigateRoute } from '../shell/use-route.js';
import { type Selection, selectionToUrlState } from '../state/selection.js';
import { useSelection } from '../state/selection-context.js';
import { serializeUrlState } from '../state/url-state.js';
import { TracePanel, type TracePanelProps } from './trace-panel.js';

/** Leave the full-page trace: drop the open trace from the selection and go back to the explorer, keeping filters. */
export function leaveTracePage(win: Window, state: Selection): void {
  state.clear('traceId');
  const search = serializeUrlState(selectionToUrlState({ ...state, traceId: null, spanId: null }));
  navigateRoute(win, '/traces', search);
}

/** The `#/traces/trace/<id>` route: the same panel, full width. */
export function TracePage(props: {
  dataSource: DataSource;
  id: string;
  renderSpanSection?: TracePanelProps['renderSpanSection'];
}): JSX.Element {
  const sel = useSelection((s) => s);
  let traceId: ReturnType<typeof parseTraceId>;
  try {
    traceId = parseTraceId(props.id, 'route trace id');
  } catch (e) {
    const message = e instanceof OtelHtmlError ? e.message : String(e);
    return (
      <main className="p-8">
        <section role="alert" className="max-w-xl rounded-card border border-hairline bg-surface p-6">
          <h1 className="text-xl font-semibold">Invalid trace link</h1>
          <p className="mt-1 break-words font-mono text-xs text-ink-2">{message}</p>
        </section>
      </main>
    );
  }
  return (
    <TracePanel
      dataSource={props.dataSource}
      traceId={traceId}
      layout="page"
      onClose={() => leaveTracePage(window, sel)}
      {...(props.renderSpanSection === undefined ? {} : { renderSpanSection: props.renderSpanSection })}
    />
  );
}

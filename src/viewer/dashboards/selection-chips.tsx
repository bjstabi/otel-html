import { X } from 'lucide-react';
import type { JSX } from 'react';
import type { UnixNanos } from '../../model/ids.js';
import { absoluteTime } from '../shell/time-range.js';
import { type DashboardPageState, EMPTY_DASHBOARD_STATE } from '../state/dashboard-state.js';
import { parseWindow } from '../state/url-state.js';

const CHIP =
  'flex items-center gap-1 rounded-full border border-hairline bg-surface py-0.5 pr-1 pl-2 text-xs';

function Chip(props: {
  name: string;
  op: string;
  value: string;
  title?: string;
  remove: string;
  onRemove(): void;
}): JSX.Element {
  return (
    <li className={CHIP}>
      <span className="font-semibold">{props.name}</span>
      <span className="text-muted">{props.op}</span>
      <span className="font-mono tabular-nums" {...(props.title === undefined ? {} : { title: props.title })}>
        {props.value}
      </span>
      <button
        type="button"
        aria-label={props.remove}
        onClick={props.onRemove}
        className="rounded-full p-0.5 text-muted hover:bg-hairline"
      >
        <X size={12} aria-hidden />
      </button>
    </li>
  );
}

/** `9f3a…c1`: enough of a trace id to recognize it; the chip's title holds the whole id. */
function shortTrace(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-2)}`;
}

/** The selection as removable chips (`time ∈ …`, `trace_id = …`) with Clear all; nothing when nothing is selected. */
export function SelectionChips(props: {
  state: DashboardPageState;
  epoch: UnixNanos;
  /** The selected window does not overlap the page's time range, so widgets do not apply it. */
  outside: boolean;
  onChange(next: DashboardPageState): void;
}): JSX.Element | null {
  const { state, epoch } = props;
  const { t, trace } = state.sel;
  if (t === null && trace === null) return null;
  const win = t === null ? null : parseWindow(t);
  const set = (sel: DashboardPageState['sel']): void => props.onChange({ ...state, sel });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">Selection</span>
      <ul aria-label="Selection" className="flex flex-wrap items-center gap-2">
        {win !== null && (
          <Chip
            name="time"
            op="∈"
            value={`${absoluteTime(win.start, epoch)} – ${absoluteTime(win.end, epoch)}${props.outside ? ' (outside the time range)' : ''}`}
            remove="Remove time selection"
            onRemove={() => set({ ...state.sel, t: null })}
          />
        )}
        {trace !== null && (
          <Chip
            name="trace_id"
            op="="
            value={shortTrace(trace)}
            title={trace}
            remove="Remove trace selection"
            onRemove={() => set({ ...state.sel, trace: null })}
          />
        )}
      </ul>
      <button
        type="button"
        onClick={() => props.onChange({ ...state, sel: EMPTY_DASHBOARD_STATE.sel })}
        className="rounded-full px-2 py-0.5 text-xs text-accent hover:bg-hairline"
      >
        Clear all
      </button>
    </div>
  );
}

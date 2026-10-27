import type { JSX, ReactNode } from 'react';
import { PILL } from './explorer-states.js';
import { FIELD } from './field.js';

/**
 * The explorers' shared control row: mode buttons, the Group by select and the View select. Each explorer supplies
 * its own modes, views and labels; the trailing result count goes in `children`.
 */
export function ExplorerControls<M extends string, V extends string>(props: {
  /** Screen-reader legend of the mode buttons. */
  modeLegend: string;
  /** Visible text before the mode buttons, when the legend is shown. */
  modePrefix?: string;
  modes: readonly M[];
  mode: M;
  modeLabel(m: M): string;
  onMode(m: M): void;
  views: readonly V[];
  view: V;
  viewLabel(v: V): string;
  onView(v: V): void;
  groupBy: string | null;
  onGroupBy(key: string | null): void;
  /** Facet keys offered as group-by options (the current group-by stays listed even when absent). */
  facetKeys: readonly string[];
  /** Whether the current view uses the group-by. */
  grouped: boolean;
  groupByTitle: string;
  /** Id of an element that explains why the group-by is disabled. */
  groupByNoteId?: string;
  groupByNote?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const { groupBy, facetKeys, grouped } = props;
  const sortedKeys = [...facetKeys].sort();
  const groupKeys = groupBy !== null && !sortedKeys.includes(groupBy) ? [groupBy, ...sortedKeys] : sortedKeys;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <fieldset className="flex items-center gap-1 rounded-full border border-hairline bg-surface p-0.5">
        <legend className="sr-only">{props.modeLegend}</legend>
        {props.modePrefix !== undefined && (
          <span aria-hidden className="px-2 text-sm text-ink-2">
            {props.modePrefix}
          </span>
        )}
        {props.modes.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={props.mode === m}
            data-selected={props.mode === m ? 'true' : undefined}
            onClick={() => props.onMode(m)}
            className={`${PILL} ${props.mode === m ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-hairline'}`}
          >
            {props.modeLabel(m)}
          </button>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        Group by
        <select
          aria-label="Group by"
          className={FIELD}
          value={groupBy ?? ''}
          disabled={!grouped}
          title={grouped ? undefined : props.groupByTitle}
          aria-describedby={grouped ? undefined : props.groupByNoteId}
          onChange={(e) => props.onGroupBy(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Service (default)</option>
          {groupKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      {!grouped && props.groupByNote}
      <label className="flex items-center gap-2 text-sm text-ink-2">
        View
        <select
          aria-label="View"
          className={FIELD}
          value={props.view}
          onChange={(e) => {
            const next = props.views.find((x) => x === e.target.value);
            if (next !== undefined) props.onView(next);
          }}
        >
          {props.views.map((v) => (
            <option key={v} value={v}>
              {props.viewLabel(v)}
            </option>
          ))}
        </select>
      </label>
      {props.children}
    </div>
  );
}

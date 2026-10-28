import { Popover } from '@base-ui/react/popover';
import { ChevronDown, Search } from 'lucide-react';
import { type JSX, useMemo, useState } from 'react';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import { metricTypeLabel } from '../data/metric-query.js';

export const FIELD =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-hairline bg-surface px-2 py-1 text-sm';
const POPUP = 'rounded-card border border-hairline bg-surface p-2 shadow-lg';

export function TypeBadge({ entry }: { entry: Pick<MetricEntry, 'type' | 'monotonic'> }): JSX.Element {
  return (
    <span className="rounded bg-accent/10 px-1.5 text-[10.5px] font-semibold tracking-wide text-accent">
      {metricTypeLabel(entry)}
    </span>
  );
}

const unitText = (unit: string): string => (unit === '' ? 'no unit' : unit);

/**
 * The query row's metric field: type badge, name and unit, opening a searchable list of the catalog. A name with
 * conflicting definitions is listed once per definition.
 */
export function MetricPicker(props: {
  queryId: string;
  /** The query's metric name; '' while none is chosen. */
  name: string;
  /** The definition it resolved to, when it resolved to exactly one. */
  entry: MetricEntry | null;
  entries: readonly MetricEntry[];
  onPick(entry: MetricEntry): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f === ''
      ? props.entries
      : props.entries.filter((e) => e.name.toLowerCase().includes(f) || e.unit.toLowerCase().includes(f));
  }, [props.entries, filter]);
  const { entry } = props;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setFilter('');
      }}
    >
      <Popover.Trigger aria-label={`Metric of ${props.queryId}`} className={`${FIELD} min-w-64`}>
        {entry !== null && <TypeBadge entry={entry} />}
        {props.name === '' ? (
          <span className="text-muted">choose a metric</span>
        ) : (
          <span className="font-mono text-xs">{props.name}</span>
        )}
        {entry !== null && <span className="ml-auto text-xs text-muted">{unitText(entry.unit)}</span>}
        <ChevronDown size={14} aria-hidden className="text-muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start">
          <Popover.Popup className={`${POPUP} w-96`}>
            <label className="flex items-center gap-2 rounded-md border border-hairline px-2 py-1">
              <Search size={14} aria-hidden className="text-muted" />
              <input
                type="search"
                aria-label="Search metrics"
                placeholder="Search metrics and units"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full bg-transparent text-sm outline-none"
              />
            </label>
            <ul aria-label="Metrics" className="mt-2 max-h-72 overflow-y-auto">
              {shown.length === 0 && <li className="px-2 py-1 text-sm text-muted">No metric matches</li>}
              {shown.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setFilter('');
                      props.onPick(e);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-hairline"
                  >
                    <TypeBadge entry={e} />
                    <span className="truncate font-mono text-xs">{e.name}</span>
                    <span className="ml-auto text-xs text-muted">{unitText(e.unit)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** For a name with several definitions: pick one by kind and unit, which the query then names. */
export function DefinitionPicker(props: {
  name: string;
  definitions: readonly MetricEntry[];
  onPick(entry: MetricEntry): void;
}): JSX.Element {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-md border border-warning px-2 py-1 text-xs">
      <span>{props.name} has several definitions:</span>
      <select
        aria-label={`Definition of ${props.name}`}
        value=""
        onChange={(e) => {
          const picked = props.definitions.find((d) => String(d.id) === e.target.value);
          if (picked !== undefined) props.onPick(picked);
        }}
        className="rounded-md border border-hairline bg-surface px-1 py-0.5"
      >
        <option value="">choose…</option>
        {props.definitions.map((d) => (
          <option key={d.id} value={String(d.id)}>
            {metricTypeLabel(d)} · {unitText(d.unit)}
          </option>
        ))}
      </select>
    </label>
  );
}

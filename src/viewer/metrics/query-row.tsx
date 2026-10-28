import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown, Eye, EyeOff, Pencil, X } from 'lucide-react';
import { type JSX, type ReactNode, useEffect, useState } from 'react';
import { parseFormula } from '../../query/metric-formula.js';
import type { MetricFormula } from '../../query/metric-query.js';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import { ConditionEditor } from '../components/query-bar.js';
import type { MetricFn, MetricQuery } from '../data/metric-query.js';
import { DefinitionPicker, FIELD, MetricPicker } from './metric-picker.js';

const POPUP = 'rounded-card border border-hairline bg-surface p-1 shadow-lg';
const ITEM = 'rounded-md px-3 py-1.5 text-sm hover:bg-hairline';
const ICON = 'rounded-md p-1 text-muted hover:bg-hairline';
const MINUTE_MS = 60_000;

/** The `ƒ` menu: one preset per function; each is applied in order after the query. */
const FN_PRESETS: readonly { label: string; fn: MetricFn }[] = [
  { label: 'rate', fn: { op: 'rate' } },
  { label: 'increase', fn: { op: 'increase' } },
  { label: 'rollup avg 1m', fn: { op: 'rollup', agg: 'avg', intervalMs: MINUTE_MS } },
  { label: 'rollup max 1m', fn: { op: 'rollup', agg: 'max', intervalMs: MINUTE_MS } },
  { label: 'rollup sum 1m', fn: { op: 'rollup', agg: 'sum', intervalMs: MINUTE_MS } },
  { label: 'top 5 by avg', fn: { op: 'top', n: 5, by: 'avg' } },
  { label: 'bottom 5 by avg', fn: { op: 'bottom', n: 5, by: 'avg' } },
];

export function fnLabel(f: MetricFn): string {
  switch (f.op) {
    case 'rate':
    case 'increase':
      return f.op;
    case 'rollup':
      return `rollup ${f.agg} ${f.intervalMs % MINUTE_MS === 0 ? `${f.intervalMs / MINUTE_MS}m` : `${f.intervalMs}ms`}`;
    case 'top':
    case 'bottom':
      return `${f.op} ${f.n} by ${f.by}`;
    default: {
      const never: never = f;
      throw new Error(`unhandled metric fn ${JSON.stringify(never)}`);
    }
  }
}

/** `resource.attributes["service.name"]` is shown as `service.name`, a point attribute as itself. */
export function byKeyLabel(path: string): string {
  const m = /^(?:resource\.)?attributes\["(.*)"\]$/.exec(path);
  return m?.[1] ?? path;
}

export function IdChip(props: { id: string; colorToken: string }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{ background: `var(${props.colorToken})` }}
      className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1 font-mono text-xs font-bold text-white"
    >
      {props.id}
    </span>
  );
}

function Labelled(props: { label: string; children: ReactNode }): JSX.Element {
  // A div: the `where` editor holds a list and a form.
  return (
    <div className={FIELD}>
      <span className="text-xs text-muted">{props.label}</span>
      {props.children}
    </div>
  );
}

function ByPicker(props: {
  queryId: string;
  options: readonly string[];
  chosen: readonly string[];
  onChange(by: string[]): void;
}): JSX.Element {
  const { chosen } = props;
  // Chosen keys stay listed even when the metric no longer has them, so they can be unticked.
  const all = [...new Set([...chosen, ...props.options])];
  return (
    <Popover.Root>
      <Popover.Trigger aria-label={`By of ${props.queryId}`} className={FIELD}>
        <span className="text-xs text-muted">by</span>
        {chosen.length === 0 ? (
          <span className="text-muted">everything</span>
        ) : (
          <span className="font-mono text-xs">{chosen.map(byKeyLabel).join(', ')}</span>
        )}
        <ChevronDown size={14} aria-hidden className="text-muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start">
          <Popover.Popup className={`${POPUP} max-h-72 overflow-y-auto p-2`}>
            {all.length === 0 && <p className="px-2 text-sm text-muted">No attributes to group by</p>}
            {all.map((path) => (
              <label key={path} className="flex items-center gap-2 px-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(path)}
                  onChange={(e) =>
                    props.onChange(e.target.checked ? [...chosen, path] : chosen.filter((p) => p !== path))
                  }
                />
                <span className="font-mono text-xs">{path}</span>
              </label>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FnPicker(props: {
  queryId: string;
  fns: readonly MetricFn[];
  onChange(fns: MetricFn[]): void;
}): JSX.Element {
  const { fns } = props;
  return (
    <span className={FIELD}>
      <span className="text-xs text-muted">ƒ</span>
      {fns.length === 0 && <span className="text-muted">none</span>}
      {fns.map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: functions have no identity; the same one may repeat
        <span key={i} className="inline-flex items-center gap-0.5 font-mono text-xs">
          {fnLabel(f)}
          <button
            type="button"
            aria-label={`Remove ${fnLabel(f)} from ${props.queryId}`}
            onClick={() => props.onChange(fns.filter((_, j) => j !== i))}
            className={ICON}
          >
            <X size={10} aria-hidden />
          </button>
        </span>
      ))}
      <Menu.Root>
        <Menu.Trigger aria-label={`Add function to ${props.queryId}`} className={ICON}>
          <ChevronDown size={14} aria-hidden />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} align="start">
            <Menu.Popup className={POPUP}>
              {FN_PRESETS.map((p) => (
                <Menu.Item key={p.label} className={ITEM} onClick={() => props.onChange([...fns, p.fn])}>
                  {p.label}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}

/** A text field committed on Enter or blur; `commit` returns an error message to keep the draft open. */
function DraftInput(props: {
  label: string;
  value: string;
  placeholder?: string;
  className?: string;
  commit(text: string): string | null;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an outside change (URL, Back) discards the draft
  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [props.value]);
  const done = (): void => {
    if (draft === null) return;
    const problem = props.commit(draft);
    setError(problem);
    if (problem === null) setDraft(null);
  };
  return (
    <span className="inline-flex flex-col">
      <input
        type="text"
        aria-label={props.label}
        aria-invalid={error !== null}
        placeholder={props.placeholder}
        value={draft ?? props.value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done();
        }}
        className={`rounded-md border border-hairline bg-surface px-2 py-1 font-mono text-xs ${props.className ?? ''}`}
      />
      {error !== null && (
        <span role="alert" className="font-mono text-xs text-critical">
          {error}
        </span>
      )}
    </span>
  );
}

/** Alias, hide and remove: the end of every query and formula row. */
function RowActions(props: {
  id: string;
  alias: string | null;
  hidden: boolean;
  canRemove: boolean;
  onAlias(alias: string | null): void;
  onHidden(hidden: boolean): void;
  onRemove(): void;
}): JSX.Element {
  const [editing, setEditing] = useState(props.alias !== null);
  return (
    <span className="ml-auto inline-flex items-center gap-1">
      {editing ? (
        <DraftInput
          label={`Alias of ${props.id}`}
          value={props.alias ?? ''}
          placeholder="alias"
          className="w-32"
          commit={(t) => {
            const v = t.trim();
            props.onAlias(v === '' ? null : v);
            if (v === '') setEditing(false);
            return null;
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={`${ICON} inline-flex items-center gap-1 text-xs`}
        >
          <Pencil size={12} aria-hidden />
          alias
        </button>
      )}
      <button
        type="button"
        aria-label={`Hide ${props.id}`}
        aria-pressed={props.hidden}
        onClick={() => props.onHidden(!props.hidden)}
        className={ICON}
      >
        {props.hidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
      </button>
      <button
        type="button"
        aria-label={`Remove ${props.id}`}
        disabled={!props.canRemove}
        onClick={props.onRemove}
        className={`${ICON} disabled:opacity-40`}
      >
        <X size={14} aria-hidden />
      </button>
    </span>
  );
}

export type Resolution = { entry: MetricEntry } | { ambiguous: MetricEntry[] } | { missing: true } | null;

/** One query row (mockup 04, screen 1): id, metric, where, show, by, ƒ, alias, hide, remove. */
export function QueryRow(props: {
  query: MetricQuery;
  colorToken: string;
  /** The query's metric in the catalog; null while the catalog loads or no metric is chosen. */
  resolution: Resolution;
  entries: readonly MetricEntry[];
  showOptions: readonly string[];
  byOptions: readonly string[];
  error: string | null;
  canRemove: boolean;
  onChange(q: MetricQuery): void;
  onPickMetric(entry: MetricEntry): void;
  onRemove(): void;
}): JSX.Element {
  const { query: q, resolution } = props;
  const entry = resolution !== null && 'entry' in resolution ? resolution.entry : null;
  const set = (patch: Partial<MetricQuery>): void => props.onChange({ ...q, ...patch });
  const shows =
    props.showOptions.includes(q.show) || q.show === '' ? props.showOptions : [q.show, ...props.showOptions];
  return (
    <li aria-label={`Query ${q.id}`} className="flex flex-col gap-1 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <IdChip id={q.id} colorToken={props.colorToken} />
        <MetricPicker
          queryId={q.id}
          name={q.metric}
          entry={entry}
          entries={props.entries}
          onPick={props.onPickMetric}
        />
        {resolution !== null && 'ambiguous' in resolution && (
          <DefinitionPicker name={q.metric} definitions={resolution.ambiguous} onPick={props.onPickMetric} />
        )}
        <Labelled label="where">
          <ConditionEditor
            condition={q.where}
            onChange={(where) => set({ where })}
            context="datapoint"
            rawOpen={false}
            keyPlaceholder='resource.attributes["key"]'
            labelSuffix={` of ${q.id}`}
          />
        </Labelled>
        <Labelled label="show">
          <select
            aria-label={`Show of ${q.id}`}
            value={q.show}
            disabled={shows.length === 0}
            onChange={(e) => set({ show: e.target.value })}
            className="bg-transparent text-sm"
          >
            {shows.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Labelled>
        <ByPicker queryId={q.id} options={props.byOptions} chosen={q.by} onChange={(by) => set({ by })} />
        <FnPicker queryId={q.id} fns={q.fn} onChange={(fn) => set({ fn })} />
        <RowActions
          id={q.id}
          alias={q.alias}
          hidden={q.hidden}
          canRemove={props.canRemove}
          onAlias={(alias) => set({ alias })}
          onHidden={(hidden) => set({ hidden })}
          onRemove={props.onRemove}
        />
      </div>
      {props.error !== null && (
        <p role="alert" className="pl-8 text-xs text-critical">
          {props.error}
        </p>
      )}
    </li>
  );
}

/** A formula row: an expression over query ids (`a / b`), alias, hide, remove. */
export function FormulaRow(props: {
  formula: MetricFormula;
  colorToken: string;
  error: string | null;
  onChange(f: MetricFormula): void;
  onRemove(): void;
}): JSX.Element {
  const { formula: f } = props;
  return (
    <li aria-label={`Formula ${f.id}`} className="flex flex-col gap-1 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <IdChip id={f.id} colorToken={props.colorToken} />
        <Labelled label="ƒ">
          <DraftInput
            label={`Expression of ${f.id}`}
            value={f.expr}
            placeholder="a / b"
            className="w-64"
            commit={(t) => {
              const expr = t.trim();
              try {
                parseFormula(expr);
              } catch (e) {
                return e instanceof Error ? e.message : String(e);
              }
              props.onChange({ ...f, expr });
              return null;
            }}
          />
        </Labelled>
        <RowActions
          id={f.id}
          alias={f.alias}
          hidden={f.hidden}
          canRemove
          onAlias={(alias) => props.onChange({ ...f, alias })}
          onHidden={(hidden) => props.onChange({ ...f, hidden })}
          onRemove={props.onRemove}
        />
      </div>
      {props.error !== null && (
        <p role="alert" className="pl-8 text-xs text-critical">
          {props.error}
        </p>
      )}
    </li>
  );
}

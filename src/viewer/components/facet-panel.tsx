import { type JSX, useState } from 'react';
import { OtelHtmlError } from '../../model/errors.js';
import type { FacetCounts } from '../../rollups/facets.js';
import { useSelection } from '../state/selection-context.js';
import {
  type FilterToken,
  facetKeyToPath,
  ottlToTokens,
  RESOURCE_KEY_PREFIX,
  tokensToOttl,
} from './filter-tokens.js';

/** One duration bin: `[fromNs, toNs)` with the span count inside it. */
export interface DurationBin {
  fromNs: number;
  toNs: number;
  count: number;
}

export const DURATION_KEY = 'span.end_time_unix_nano - span.start_time_unix_nano';

export type FacetAction = 'only' | 'exclude';

interface FacetDef {
  /** Key in the rollup's `FacetCounts`. */
  key: string;
  label: string;
  /** Key handed to `facetKeyToPath`; differs from `key` for resource attributes. */
  filterKey: string;
}

const CORE: readonly FacetDef[] = [
  { key: 'service.name', label: 'Service', filterKey: 'service.name' },
  { key: 'span.name', label: 'Span name', filterKey: 'span.name' },
  { key: 'span.kind', label: 'Kind', filterKey: 'span.kind' },
  { key: 'status.code', label: 'Status', filterKey: 'status.code' },
  { key: 'instrumentation_scope.name', label: 'Scope', filterKey: 'instrumentation_scope.name' },
];
const RESOURCE: readonly FacetDef[] = [
  { key: 'host.name', label: 'Host', filterKey: `${RESOURCE_KEY_PREFIX}host.name` },
  {
    key: 'deployment.environment.name',
    label: 'Environment',
    filterKey: `${RESOURCE_KEY_PREFIX}deployment.environment.name`,
  },
];
/** Rollup keys that are never listed under Attributes: grouped above, or derived with no filterable path. */
const NOT_ATTRIBUTES: ReadonlySet<string> = new Set(
  [...CORE, ...RESOURCE].map((d) => d.key).concat('resource'),
);

const HATCH =
  'repeating-linear-gradient(45deg, var(--oh-critical) 0 3px, color-mix(in srgb, var(--oh-critical) 25%, transparent) 3px 6px)';
const VALUES_PER_FACET = 8;

const RAW_MESSAGE =
  'The condition is raw OTTL that is not a plain list of filters, so facets cannot edit it. Edit it in the query bar or clear it first.';

function FacetRow(props: {
  def: FacetDef;
  value: string;
  count: number;
  total: number;
  state: 'include' | 'exclude' | null;
  onAction(a: FacetAction): void;
}): JSX.Element {
  const share = props.total === 0 ? 0 : props.count / props.total;
  const isError = props.def.key === 'status.code' && props.value === 'error';
  return (
    <li
      data-testid={`facet-row:${props.def.key}:${props.value}`}
      data-state={props.state ?? undefined}
      className="group relative flex items-center gap-2 rounded-md px-1 py-0.5 text-xs"
    >
      <span
        aria-hidden
        data-hatch={isError ? '' : undefined}
        className="absolute inset-y-0 left-0 rounded-md opacity-25"
        style={{
          width: `${share * 100}%`,
          background: isError ? HATCH : 'var(--oh-accent)',
        }}
      />
      <span
        className={`relative min-w-0 flex-1 truncate font-mono ${
          props.state === 'include'
            ? 'w-fit flex-none rounded-full bg-ink px-2 text-page'
            : props.state === 'exclude'
              ? 'line-through'
              : ''
        }`}
        title={props.value}
      >
        {props.value}
      </span>
      {props.state === 'exclude' ? <span className="relative text-muted">excluded</span> : null}
      <span className="relative ml-auto font-mono tabular-nums">{props.count}</span>
      <span className="relative w-9 text-right font-mono tabular-nums text-muted">
        {Math.round(share * 100)}%
      </span>
      <span className="relative flex gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          aria-label={`Only ${props.value}`}
          onClick={() => props.onAction('only')}
          className="rounded-full border border-hairline bg-surface px-1.5 hover:bg-hairline"
        >
          only
        </button>
        <button
          type="button"
          aria-label={`Exclude ${props.value}`}
          onClick={() => props.onAction('exclude')}
          className="rounded-full border border-hairline bg-surface px-1.5 hover:bg-hairline"
        >
          exclude
        </button>
      </span>
    </li>
  );
}

function FacetBlock(props: {
  def: FacetDef;
  facets: FacetCounts;
  search: string;
  tokens: readonly FilterToken[] | null;
  onAction(def: FacetDef, value: string, a: FacetAction): void;
}): JSX.Element | null {
  const { def, facets } = props;
  const total = facets.total(def.key);
  const needle = props.search.toLowerCase();
  const values = facets
    .top(def.key, VALUES_PER_FACET)
    .filter((v) => needle === '' || v.value.toLowerCase().includes(needle));
  if (total === 0 || values.length === 0) return null;
  const path = facetKeyToPath(def.filterKey, 'span');
  const other = needle === '' ? facets.other(def.key) : 0;
  return (
    <section aria-label={def.label} className="flex flex-col gap-0.5">
      <h4 className="text-xs font-medium text-muted">{def.label}</h4>
      <ul className="flex flex-col">
        {values.map((v) => {
          const t = props.tokens?.find((x) => x.key === path && x.value === v.value);
          return (
            <FacetRow
              key={v.value}
              def={def}
              value={v.value}
              count={v.count}
              total={total}
              state={t?.op === '==' ? 'include' : t?.op === '!=' ? 'exclude' : null}
              onAction={(a) => props.onAction(def, v.value, a)}
            />
          );
        })}
        {other > 0 ? (
          <li className="px-1 py-0.5 text-xs text-muted">
            <span>other</span> <span className="font-mono tabular-nums">{other}</span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function DurationFacet(props: {
  bins: readonly DurationBin[];
  tokens: readonly FilterToken[] | null;
  onRange(lo: number, hi: number): void;
}): JSX.Element {
  const { bins } = props;
  const last = bins.length - 1;
  const lo = (() => {
    const t = props.tokens?.find((x) => x.key === DURATION_KEY && x.op === '>=');
    const i = bins.findIndex((b) => b.fromNs === t?.value);
    return Math.max(i, 0);
  })();
  const hi = (() => {
    const t = props.tokens?.find((x) => x.key === DURATION_KEY && x.op === '<=');
    const i = bins.findIndex((b) => b.toNs === t?.value);
    return i < 0 ? last : i;
  })();
  const [drag, setDrag] = useState<number | null>(null);
  const max = Math.max(1, ...bins.map((b) => b.count));
  const step =
    (which: 'min' | 'max') =>
    (e: React.KeyboardEvent): void => {
      const d =
        e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
            ? -1
            : 0;
      if (d === 0) return;
      e.preventDefault();
      if (which === 'min') props.onRange(Math.min(Math.max(lo + d, 0), hi), hi);
      else props.onRange(lo, Math.max(Math.min(hi + d, last), lo));
    };
  return (
    <section aria-label="Duration" className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted">Duration</h4>
      <div
        className="flex h-12 items-end gap-px"
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {bins.map((b, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: bins are positional
            key={i}
            data-bin={i}
            title={`${b.fromNs}-${b.toNs} ns: ${b.count}`}
            onPointerDown={() => setDrag(i)}
            onPointerEnter={() => {
              if (drag !== null) props.onRange(Math.min(drag, i), Math.max(drag, i));
            }}
            className={`flex-1 cursor-col-resize rounded-sm ${i >= lo && i <= hi ? 'bg-accent' : 'bg-hairline'}`}
            style={{ height: `${Math.max(8, (b.count / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-xs tabular-nums">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Minimum duration"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={lo}
          aria-valuetext={`from ${bins[lo]?.fromNs ?? 0} ns`}
          onKeyDown={step('min')}
          className="rounded-full border border-hairline px-2 py-0.5"
        >
          {bins[lo]?.fromNs ?? 0} ns
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Maximum duration"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={hi}
          aria-valuetext={`up to ${bins[hi]?.toNs ?? 0} ns`}
          onKeyDown={step('max')}
          className="rounded-full border border-hairline px-2 py-0.5"
        >
          {bins[hi]?.toNs ?? 0} ns
        </div>
      </div>
    </section>
  );
}

export interface FacetPanelProps {
  facets: FacetCounts;
  /** Observer called after a facet action has been written to the store. */
  onToggle?(key: string, value: string, action: FacetAction): void;
  /** Duration distribution; the Duration facet is omitted without it. */
  durationBins?: readonly DurationBin[];
  /** Attribute keys revealed per step (default 5). */
  attributePageSize?: number;
}

/** Core / Resource / Attributes facets; "only" and "exclude" edit the selection's filter tokens. */
export function FacetPanel(props: FacetPanelProps): JSX.Element {
  const condition = useSelection((s) => s.condition);
  const setCondition = useSelection((s) => s.setCondition);
  const toggleFacet = useSelection((s) => s.toggleFacet);
  const pageSize = props.attributePageSize ?? 5;
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(pageSize);
  const [error, setError] = useState<string | null>(null);
  const tokens = condition === null ? [] : ottlToTokens(condition);

  const act = (def: FacetDef, value: string, action: FacetAction): void => {
    if (tokens === null) {
      setError(RAW_MESSAGE);
      return;
    }
    try {
      if (action === 'only') {
        const path = facetKeyToPath(def.filterKey, 'span');
        setCondition(tokensToOttl([...tokens.filter((t) => t.key !== path), { key: path, op: '==', value }]));
      } else {
        toggleFacet(def.filterKey, value, 'exclude');
      }
      setError(null);
      props.onToggle?.(def.filterKey, value, action);
    } catch (e) {
      setError(e instanceof OtelHtmlError ? e.message : RAW_MESSAGE);
    }
  };

  const setRange = (lo: number, hi: number): void => {
    const bins = props.durationBins ?? [];
    const first = bins[lo];
    const lastBin = bins[hi];
    if (tokens === null || first === undefined || lastBin === undefined) {
      setError(RAW_MESSAGE);
      return;
    }
    const rest = tokens.filter((t) => t.key !== DURATION_KEY);
    if (lo > 0) rest.push({ key: DURATION_KEY, op: '>=', value: first.fromNs });
    if (hi < bins.length - 1) rest.push({ key: DURATION_KEY, op: '<=', value: lastBin.toNs });
    try {
      setCondition(tokensToOttl(rest));
      setError(null);
    } catch (e) {
      setError(e instanceof OtelHtmlError ? e.message : RAW_MESSAGE);
    }
  };

  const attributeKeys = props.facets
    .keys()
    .filter((k) => !NOT_ATTRIBUTES.has(k))
    .sort((a, b) => props.facets.total(b) - props.facets.total(a) || (a < b ? -1 : a > b ? 1 : 0));
  const attributeDefs: FacetDef[] = attributeKeys
    .slice(0, shown)
    .map((k) => ({ key: k, label: k, filterKey: k }));

  const block = (def: FacetDef): JSX.Element => (
    <FacetBlock
      key={def.key}
      def={def}
      facets={props.facets}
      search={search}
      tokens={tokens}
      onAction={act}
    />
  );

  return (
    <aside
      aria-label="Facets"
      className="flex flex-col gap-4 rounded-card border border-hairline bg-surface p-3"
    >
      <input
        type="search"
        aria-label="Search facet values"
        placeholder="Search values"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="rounded-full border border-hairline bg-page px-3 py-1 text-sm"
      />
      {error === null ? null : (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Core</h3>
        {CORE.map(block)}
        {props.durationBins === undefined || props.durationBins.length === 0 ? null : (
          <DurationFacet bins={props.durationBins} tokens={tokens} onRange={setRange} />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Resource</h3>
        {RESOURCE.map(block)}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Attributes</h3>
          <span className="text-xs text-muted">
            {Math.min(shown, attributeKeys.length)} of {attributeKeys.length} shown
          </span>
          {shown < attributeKeys.length ? (
            <button
              type="button"
              onClick={() => setShown(shown + pageSize)}
              className="rounded-full border border-hairline px-2 text-xs hover:bg-hairline"
            >
              Add
            </button>
          ) : null}
        </div>
        {attributeDefs.map(block)}
      </div>
    </aside>
  );
}

import { type JSX, useState } from 'react';
import { OtelHtmlError } from '../../model/errors.js';
import type { FacetCounts } from '../../rollups/facets.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey } from '../../rollups/signal-counts.js';
import { useSelection } from '../state/selection-context.js';
import {
  type FacetScope,
  type FacetSignal,
  type FacetValueKind,
  type FilterToken,
  facetFilterable,
  facetToken,
  ottlToTokens,
  SEVERITY_BOUNDS,
  SEVERITY_PATH,
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

const SEVERITY_FACET = 'severity';
const SEVERITY_EXCLUDE_MESSAGE =
  'Excluding a severity needs "or", which facets cannot write. Use the query bar.';

function isSeverityKey(v: string): v is LogSeverityKey {
  return LOG_SEVERITY_KEYS.some((k) => k === v);
}

interface FacetDef {
  /** Key in the rollup's `FacetCounts`. */
  key: string;
  label: string;
  /** Where the key lives in the data; passed to `facetKeyToPath` so the key text is never interpreted. */
  scope: FacetScope;
}

/** Per-signal facet groups, in display order. Log facets are one flat list (Host sits between Service and Scope). */
const FACET_DEFS: Record<FacetSignal, { core: readonly FacetDef[]; resource: readonly FacetDef[] }> = {
  span: {
    core: [
      { key: 'service.name', label: 'Service', scope: 'core' },
      { key: 'span.name', label: 'Span name', scope: 'core' },
      { key: 'span.kind', label: 'Kind', scope: 'core' },
      { key: 'status.code', label: 'Status', scope: 'core' },
      { key: 'instrumentation_scope.name', label: 'Scope', scope: 'core' },
    ],
    resource: [
      { key: 'host.name', label: 'Host', scope: 'resource' },
      { key: 'deployment.environment.name', label: 'Environment', scope: 'resource' },
    ],
  },
  log: {
    core: [
      { key: SEVERITY_FACET, label: 'Severity', scope: 'core' },
      { key: 'service.name', label: 'Service', scope: 'core' },
      { key: 'host.name', label: 'Host', scope: 'resource' },
      { key: 'instrumentation_scope.name', label: 'Scope', scope: 'core' },
      { key: 'event.name', label: 'Event name', scope: 'core' },
      { key: 'trace.present', label: 'Has trace', scope: 'core' },
    ],
    resource: [],
  },
};

/** Rollup keys that are never listed under Attributes: grouped above, or derived with no filterable path. */
function notAttributes(signal: FacetSignal): ReadonlySet<string> {
  const { core, resource } = FACET_DEFS[signal];
  return new Set([...core, ...resource].map((d) => d.key).concat('resource'));
}

const HATCH =
  'repeating-linear-gradient(45deg, var(--oh-critical) 0 3px, color-mix(in srgb, var(--oh-critical) 25%, transparent) 3px 6px)';
const VALUES_PER_FACET = 8;

const MIXED_MESSAGE =
  'This key holds values of more than one type, so facets cannot filter it. Use the query bar.';

const RAW_MESSAGE =
  'The condition is raw OTTL that is not a plain list of filters, so facets cannot edit it. Edit it in the query bar or clear it first.';

function FacetRow(props: {
  def: FacetDef;
  value: string;
  count: number;
  total: number;
  state: 'include' | 'exclude' | null;
  /** False when no exact filter exists for the key (mixed value types); the buttons are disabled. */
  filterable: boolean;
  onAction(a: FacetAction): void;
  /** Severity rows replace Only/Exclude with Only / And above / a disabled Exclude. */
  onAndAbove?(): void;
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
          disabled={!props.filterable}
          title={props.filterable ? undefined : MIXED_MESSAGE}
          onClick={() => props.onAction('only')}
          className="rounded-full border border-hairline bg-surface px-1.5 hover:bg-hairline"
        >
          only
        </button>
        {props.onAndAbove === undefined ? null : (
          <button
            type="button"
            aria-label={`And above ${props.value}`}
            onClick={props.onAndAbove}
            className="rounded-full border border-hairline bg-surface px-1.5 hover:bg-hairline"
          >
            and above
          </button>
        )}
        <button
          type="button"
          aria-label={`Exclude ${props.value}`}
          disabled={!props.filterable || props.onAndAbove !== undefined}
          title={
            props.onAndAbove !== undefined
              ? SEVERITY_EXCLUDE_MESSAGE
              : props.filterable
                ? undefined
                : MIXED_MESSAGE
          }
          onClick={() => props.onAction('exclude')}
          className="rounded-full border border-hairline bg-surface px-1.5 hover:bg-hairline"
        >
          exclude
        </button>
      </span>
    </li>
  );
}

/** Every tracked value of `key` (count descending) whose text contains `search`; truncation is the caller's job. */
function matchingValues(
  facets: FacetCounts,
  key: string,
  search: string,
): { value: string; count: number }[] {
  const needle = search.toLowerCase();
  return facets
    .top(key, facets.valueCap)
    .filter((v) => needle === '' || v.value.toLowerCase().includes(needle));
}

/** The token a row stands for, or null when none can be built (the row then shows no include/exclude state). */
function displayToken(
  def: FacetDef,
  value: string,
  kind: FacetValueKind | undefined,
  signal: FacetSignal,
  op: '==' | '!=',
): FilterToken | null {
  try {
    return facetToken(def.key, def.scope, value, op, kind, signal);
  } catch (e) {
    if (e instanceof OtelHtmlError && e.code === 'usage') return null;
    throw e;
  }
}

/** A severity row is included when the condition is exactly that band's `>= first and <= last` pair. */
function severityIncluded(tokens: readonly FilterToken[] | null, band: LogSeverityKey): boolean {
  const { first, last } = SEVERITY_BOUNDS[band];
  const has = (op: '>=' | '<=', value: string): boolean =>
    tokens?.some((t) => t.key === SEVERITY_PATH && t.op === op && t.value === value) ?? false;
  return has('>=', first) && has('<=', last);
}

function FacetBlock(props: {
  signal: FacetSignal;
  def: FacetDef;
  facets: FacetCounts;
  search: string;
  tokens: readonly FilterToken[] | null;
  onAction(def: FacetDef, value: string, a: FacetAction): void;
  onSeverity(min: LogSeverityKey, max: LogSeverityKey | null): void;
}): JSX.Element | null {
  const { def, facets } = props;
  const total = facets.total(def.key);
  // A severity value outside the band names is bad rollup data; skip it rather than filter `log.attributes["severity"]`.
  const matches = matchingValues(facets, def.key, props.search).filter(
    (v) => !(props.signal === 'log' && def.key === SEVERITY_FACET) || isSeverityKey(v.value),
  );
  const values = matches.slice(0, VALUES_PER_FACET);
  if (total === 0 || values.length === 0) return null;
  const kind = facets.kind(def.key);
  const filterable = facetFilterable(kind);
  const other = facets.other(def.key);
  const hidden = matches.length - values.length;
  return (
    <section aria-label={def.label} className="flex flex-col gap-0.5">
      <h4 className="text-xs font-medium text-muted">{def.label}</h4>
      <ul className="flex flex-col">
        {values.map((v) => {
          const band =
            props.signal === 'log' && def.key === SEVERITY_FACET && isSeverityKey(v.value) ? v.value : null;
          if (band !== null) {
            return (
              <FacetRow
                key={v.value}
                def={def}
                value={v.value}
                count={v.count}
                total={total}
                filterable
                state={severityIncluded(props.tokens, band) ? 'include' : null}
                onAction={() => props.onSeverity(band, band)}
                onAndAbove={() => props.onSeverity(band, null)}
              />
            );
          }
          const has = (t: FilterToken | null): boolean =>
            t !== null &&
            (props.tokens?.some(
              (x) => x.key === t.key && x.op === t.op && x.value === t.value && x.enum === t.enum,
            ) ??
              false);
          const included = filterable && has(displayToken(def, v.value, kind, props.signal, '=='));
          const excluded = filterable && has(displayToken(def, v.value, kind, props.signal, '!='));
          return (
            <FacetRow
              key={v.value}
              def={def}
              value={v.value}
              count={v.count}
              total={total}
              filterable={filterable}
              state={included ? 'include' : excluded ? 'exclude' : null}
              onAction={(a) => props.onAction(def, v.value, a)}
            />
          );
        })}
        {hidden > 0 ? (
          <li className="px-1 py-0.5 text-xs text-muted">
            {hidden} more {hidden === 1 ? 'match' : 'matches'}
          </li>
        ) : null}
        {other > 0 ? (
          <li className="px-1 py-0.5 text-xs text-muted">
            <span>{props.search === '' ? 'other' : 'other (untracked, not searched)'}</span>{' '}
            <span className="font-mono tabular-nums">{other}</span>
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
  const committedLo = Math.max(
    bins.findIndex(
      (b) => b.fromNs === props.tokens?.find((x) => x.key === DURATION_KEY && x.op === '>=')?.value,
    ),
    0,
  );
  const hiIndex = bins.findIndex(
    (b) => b.toNs === props.tokens?.find((x) => x.key === DURATION_KEY && x.op === '<=')?.value,
  );
  const committedHi = hiIndex < 0 ? last : hiIndex;
  // A drag only previews here; the single store write happens on pointer up.
  const [drag, setDrag] = useState<{ anchor: number; current: number } | null>(null);
  const lo = drag === null ? committedLo : Math.min(drag.anchor, drag.current);
  const hi = drag === null ? committedHi : Math.max(drag.anchor, drag.current);
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
      if (which === 'min') props.onRange(Math.min(Math.max(committedLo + d, 0), committedHi), committedHi);
      else props.onRange(committedLo, Math.max(Math.min(committedHi + d, last), committedLo));
    };
  return (
    <section aria-label="Duration" className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted">Duration</h4>
      <div
        className="flex h-12 items-end gap-px"
        onPointerUp={() => {
          if (drag !== null)
            props.onRange(Math.min(drag.anchor, drag.current), Math.max(drag.anchor, drag.current));
          setDrag(null);
        }}
        onPointerLeave={() => setDrag(null)}
      >
        {bins.map((b, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: bins are positional
            key={i}
            data-bin={i}
            title={`${b.fromNs}-${b.toNs} ns: ${b.count}`}
            onPointerDown={() => setDrag({ anchor: i, current: i })}
            onPointerEnter={() => setDrag((d) => (d === null ? d : { anchor: d.anchor, current: i }))}
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
  signal: FacetSignal;
  facets: FacetCounts;
  /** Observer called after a facet action has been written to the store, with the facet's key and scope. */
  onToggle?(facet: { key: string; scope: FacetScope }, value: string, action: FacetAction): void;
  /** Duration distribution; the Duration facet is omitted without it. */
  durationBins?: readonly DurationBin[];
  /** Attribute keys revealed per step (default 5). */
  attributePageSize?: number;
}

/**
 * Only `OtelHtmlError`s with a user-facing meaning become a message; anything else is a bug and propagates.
 * `invalid-ottl` is a non-flat condition or an unaddressable key, `usage` a rejected argument.
 */
function facetErrorMessage(e: unknown): string {
  if (e instanceof OtelHtmlError && (e.code === 'invalid-ottl' || e.code === 'usage')) {
    return e.code === 'invalid-ottl' && e.path === 'condition' ? RAW_MESSAGE : e.message;
  }
  throw e;
}

/** Core / Resource / Attributes facets; "only" and "exclude" edit the selection's filter tokens. */
export function FacetPanel(props: FacetPanelProps): JSX.Element {
  const condition = useSelection((s) => s.condition);
  const setCondition = useSelection((s) => s.setCondition);
  const toggleFacet = useSelection((s) => s.toggleFacet);
  const setSeverityRange = useSelection((s) => s.setSeverityRange);
  const defs = FACET_DEFS[props.signal];
  const pageSize = props.attributePageSize ?? 5;
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(pageSize);
  const [error, setError] = useState<string | null>(null);
  const tokens = condition === null ? [] : ottlToTokens(condition);

  const act = (def: FacetDef, value: string, action: FacetAction): void => {
    const kind = props.facets.kind(def.key);
    if (tokens === null) {
      setError(RAW_MESSAGE);
      return;
    }
    try {
      if (action === 'only') {
        // setCondition validates (parses) the condition like any other write, so this respects the store's rules.
        const want = facetToken(def.key, def.scope, value, '==', kind, props.signal);
        setCondition(tokensToOttl([...tokens.filter((t) => t.key !== want.key), want]));
      } else {
        toggleFacet(def.key, value, 'exclude', def.scope, kind, props.signal);
      }
      setError(null);
      props.onToggle?.({ key: def.key, scope: def.scope }, value, action);
    } catch (e) {
      setError(facetErrorMessage(e));
    }
  };

  const severity = (min: LogSeverityKey, max: LogSeverityKey | null): void => {
    try {
      setSeverityRange(min, max);
      setError(null);
    } catch (e) {
      setError(facetErrorMessage(e));
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
      setError(facetErrorMessage(e));
    }
  };

  // Keys are listed only when some value matches the search, so "N of M shown" stays honest while searching.
  const excluded = notAttributes(props.signal);
  const attributeKeys = props.facets
    .keys()
    .filter((k) => !excluded.has(k))
    .filter((k) => search === '' || matchingValues(props.facets, k, search).length > 0)
    .sort((a, b) => props.facets.total(b) - props.facets.total(a) || (a < b ? -1 : a > b ? 1 : 0));
  const attributeDefs: FacetDef[] = attributeKeys
    .slice(0, shown)
    .map((k) => ({ key: k, label: k, scope: 'attribute' }));

  const block = (def: FacetDef): JSX.Element => (
    <FacetBlock
      key={def.key}
      signal={props.signal}
      def={def}
      facets={props.facets}
      search={search}
      tokens={tokens}
      onAction={act}
      onSeverity={severity}
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
        {defs.core.map(block)}
        {props.durationBins === undefined || props.durationBins.length === 0 ? null : (
          <DurationFacet bins={props.durationBins} tokens={tokens} onRange={setRange} />
        )}
      </div>
      {defs.resource.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Resource</h3>
          {defs.resource.map(block)}
        </div>
      )}
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

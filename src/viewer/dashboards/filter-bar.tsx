import { Select } from '@base-ui/react/select';
import { Check, ChevronDown, Pin, PinOff, X } from 'lucide-react';
import { type JSX, useEffect, useRef, useState } from 'react';
import type { Dashboard, QuickFilter, Variable } from '../../dashboards/schema.js';
import type { AnyManifest } from '../../format/manifest.js';
import type { ResourceValues } from '../data/data-source.js';
import { POPUP } from '../shell/controls.js';
import { RangeMenu } from '../shell/time-range.js';
import type { DashboardPageState } from '../state/dashboard-state.js';
import { useStacked } from './grid.js';
import { rangeLabel } from './range-label.js';
import { ZoomRow } from './range-slider.js';
import type { VariableBindings } from './scope.js';
import { MORE, optionsOf, withVariable } from './variables-bar.js';

const PIN_KEY = 'otel-html.filters.pinned';

function readPinned(): boolean {
  try {
    return window.localStorage.getItem(PIN_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writePinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(PIN_KEY, String(pinned));
  } catch {
    // storage is unavailable: the choice lasts until the page is left
  }
}

/** The value a variable has now: the page's override, else the config's default. */
function currentOf(variable: Variable, state: DashboardPageState): string | null {
  return Object.hasOwn(state.vars, variable.key) ? (state.vars[variable.key] ?? null) : variable.default;
}

/** `vars` after pressing a quick filter: every key of its `set` becomes the stated value. */
function withQuick(
  vars: DashboardPageState['vars'],
  variables: readonly Variable[],
  quick: QuickFilter,
): DashboardPageState['vars'] {
  let next = vars;
  for (const [key, value] of Object.entries(quick.set)) {
    const variable = variables.find((v) => v.key === key);
    if (variable !== undefined) next = withVariable(next, variable, value);
  }
  return next;
}

function matches(quick: QuickFilter, variables: readonly Variable[], state: DashboardPageState): boolean {
  return Object.entries(quick.set).every(([key, value]) => {
    const variable = variables.find((v) => v.key === key);
    return variable !== undefined && currentOf(variable, state) === value;
  });
}

const CHIP = 'flex items-center rounded-full border border-hairline bg-surface text-xs';

function VariableChip(props: {
  variable: Variable;
  known: ResourceValues;
  state: DashboardPageState;
  onChange(vars: DashboardPageState['vars']): void;
}): JSX.Element {
  const { variable, known, state } = props;
  const current = currentOf(variable, state);
  const options = optionsOf(known, current, variable.default);
  const choose = (value: string | null): void => props.onChange(withVariable(state.vars, variable, value));
  return (
    <div className={`${CHIP} ${current === null ? 'border-dashed' : ''}`}>
      <Select.Root items={options} value={current} onValueChange={(v) => v !== MORE && choose(v)}>
        <Select.Trigger
          aria-label={variable.label}
          className="flex items-center gap-1 rounded-full py-1 pr-2 pl-3 hover:bg-hairline"
        >
          <span className="font-mono">
            {current === null ? (
              `+ ${variable.label}`
            ) : (
              <>
                <span className="text-muted">{variable.label} = </span>
                {current}
              </>
            )}
          </span>
          <ChevronDown size={12} aria-hidden />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={6} className="z-20">
            <Select.Popup className={`${POPUP} max-h-72 overflow-auto`}>
              {options.map((o) => (
                <Select.Item
                  key={o.value ?? '\u0000all'}
                  value={o.value}
                  disabled={o.disabled === true}
                  className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm data-[disabled]:text-muted data-[highlighted]:bg-hairline"
                >
                  <Select.ItemIndicator>
                    <Check size={12} aria-hidden />
                  </Select.ItemIndicator>
                  <Select.ItemText>{o.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      {current !== null && (
        <button
          type="button"
          aria-label={`Clear ${variable.label}`}
          onClick={() => choose(null)}
          className="mr-1 rounded-full p-1 text-muted hover:bg-hairline"
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

export interface FilterBarSlider {
  extent: [number, number];
  zoom: [number, number] | null;
  /** The page window as a preset text (`all`, `7d`); null for a custom window. */
  preset: string | null;
  epoch: bigint;
}

/**
 * The page filter bar: quick pills, the range dropdown, one chip per variable, the run count slot, the pin and the
 * slider row. Pinned (sticky) by default; the choice is kept in `localStorage`. It replaces the shell's range
 * buttons on a dashboard page.
 */
export function FilterBar(props: {
  dashboard: Dashboard;
  manifest: AnyManifest;
  values: Readonly<Record<string, ResourceValues>>;
  bound: VariableBindings;
  state: DashboardPageState;
  onVars(vars: DashboardPageState['vars']): void;
  onZoom(zoom: [number, number] | null): void;
  slider: FilterBarSlider | null;
}): JSX.Element {
  const { dashboard, state, bound, slider } = props;
  const [pinned, setPinned] = useState(readPinned);
  const [stuck, setStuck] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const phone = useStacked();
  useEffect(() => {
    const el = sentinel.current;
    if (!pinned || el === null || typeof IntersectionObserver !== 'function') {
      setStuck(false);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last !== undefined) setStuck(!last.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [pinned]);
  const shown = dashboard.variables.filter((v) => !bound.hidden.includes(v.key));
  const hidden = bound.hidden.length;
  const l = slider === null ? null : rangeLabel(slider);
  const togglePin = (): void => {
    writePinned(!pinned);
    setPinned(!pinned);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div ref={sentinel} aria-hidden className="h-px" />
      <fieldset
        data-testid="filter-bar"
        className={`m-0 flex min-w-0 flex-col gap-2 rounded-card border border-hairline bg-surface p-3 ${pinned ? 'sticky top-0 z-10' : ''} ${stuck ? 'stuck shadow-md' : ''}`}
      >
        <legend className="sr-only">Page filters</legend>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden className="text-xs font-semibold uppercase tracking-wide text-muted">
            Page filters
          </span>
          {dashboard.quick.length > 0 && (
            <fieldset className="flex gap-1">
              <legend className="sr-only">Quick filters</legend>
              {dashboard.quick.map((q) => {
                const on = matches(q, dashboard.variables, state);
                return (
                  <button
                    key={q.label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => props.onVars(withQuick(state.vars, dashboard.variables, q))}
                    className={`rounded-full px-3 py-1 text-sm ${on ? 'bg-ink text-page font-medium' : 'text-ink-2 hover:bg-hairline'}`}
                  >
                    {q.label}
                  </button>
                );
              })}
            </fieldset>
          )}
          {l !== null && (
            <>
              <RangeMenu manifest={props.manifest} label={`${l.label}${l.of ?? ''}`} zoomed={l.zoomed} />
              {l.zoomed && (
                <button
                  type="button"
                  onClick={() => props.onZoom(null)}
                  className="rounded-full px-2 py-1 text-xs text-accent hover:bg-hairline"
                >
                  ↺ full range
                </button>
              )}
            </>
          )}
          {shown.map((v) => {
            const known = props.values[v.key];
            return known === undefined ? null : (
              <VariableChip key={v.key} variable={v} known={known} state={state} onChange={props.onVars} />
            );
          })}
          {hidden > 0 && (
            <span className="text-xs text-muted">
              {hidden === 1 ? '1 variable has' : `${hidden} variables have`} no values in this report
            </span>
          )}
          <div data-testid="run-count-slot" className="ml-auto flex items-center" />
          <button
            type="button"
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin filters' : 'Pin filters'}
            title={pinned ? 'Unpin filters' : 'Pin filters to the top'}
            onClick={togglePin}
            className="rounded-full p-1.5 text-ink-2 hover:bg-hairline"
          >
            {pinned ? <Pin size={14} aria-hidden /> : <PinOff size={14} aria-hidden />}
          </button>
        </div>
        {bound.unusable.map((u) => (
          <p key={u.key} role="alert" className="font-mono text-xs text-critical">
            {u.key} = {u.value} can't be applied: {u.reason}
          </p>
        ))}
        {slider !== null && !(stuck && phone) && <ZoomRow {...slider} label={false} onZoom={props.onZoom} />}
      </fieldset>
    </div>
  );
}

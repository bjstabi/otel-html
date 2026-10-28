import { Select } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import type { JSX } from 'react';
import type { Variable } from '../../dashboards/schema.js';
import type { ResourceValues } from '../data/data-source.js';
import { POPUP } from '../shell/page-chrome.js';
import type { DashboardPageState } from '../state/dashboard-state.js';
import type { VariableBindings } from './scope.js';

/** The disabled last item of a capped list; never a real value. */
const MORE = '\u0000more';

interface Option {
  label: string;
  value: string | null;
  disabled?: boolean;
}

/**
 * "all" first, then the values, then the cap note. The current value and the config's default are listed even when
 * the report has no such value: an option that disappears on selection makes the Select report "all" right after.
 */
function optionsOf(known: ResourceValues, current: string | null, fallback: string | null): Option[] {
  const extra = [current, fallback].filter(
    (v, i, all): v is string => v !== null && all.indexOf(v) === i && !known.values.includes(v),
  );
  const values = [...extra, ...known.values];
  return [
    { label: 'all', value: null },
    ...values.map((value) => ({ label: value, value })),
    ...(known.capped ? [{ label: '(more values not listed)', value: MORE, disabled: true }] : []),
  ];
}

function VariableSelect(props: {
  variable: Variable;
  known: ResourceValues;
  state: DashboardPageState;
  onChange(vars: DashboardPageState['vars']): void;
}): JSX.Element {
  const { variable, known, state } = props;
  const current = Object.hasOwn(state.vars, variable.key)
    ? (state.vars[variable.key] ?? null)
    : variable.default;
  const options = optionsOf(known, current, variable.default);
  const choose = (value: string | null): void => {
    const { [variable.key]: _dropped, ...rest } = state.vars;
    // A choice equal to the config's default is no override at all.
    props.onChange(value === variable.default ? rest : { ...rest, [variable.key]: value });
  };
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-hairline bg-surface py-0.5 pr-1 pl-3 text-xs">
      <span className="font-mono text-muted" id={`var-${variable.key}`}>
        {variable.label}
      </span>
      <Select.Root items={options} value={current} onValueChange={(v) => v !== MORE && choose(v)}>
        <Select.Trigger
          aria-labelledby={`var-${variable.key}`}
          className="flex items-center gap-1 rounded-full px-2 py-1 hover:bg-hairline"
        >
          <Select.Value>{(v: string | null) => v ?? 'all'}</Select.Value>
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
    </div>
  );
}

/**
 * One dropdown per variable that has values in this report. Hidden variables are counted, and a value that cannot
 * be applied as a filter says so, never silently.
 */
export function VariablesBar(props: {
  variables: readonly Variable[];
  values: Readonly<Record<string, ResourceValues>>;
  bound: VariableBindings;
  state: DashboardPageState;
  onChange(vars: DashboardPageState['vars']): void;
}): JSX.Element | null {
  const { variables, values, bound, state } = props;
  const shown = variables.filter((v) => !bound.hidden.includes(v.key));
  const hidden = bound.hidden.length;
  if (shown.length === 0 && hidden === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Filter</span>
        {shown.map((v) => {
          const known = values[v.key];
          return known === undefined ? null : (
            <VariableSelect key={v.key} variable={v} known={known} state={state} onChange={props.onChange} />
          );
        })}
        {hidden > 0 && (
          <span className="text-xs text-muted">
            {hidden === 1 ? '1 variable has' : `${hidden} variables have`} no values in this report
          </span>
        )}
      </div>
      {bound.unusable.map((u) => (
        <p key={u.key} role="alert" className="font-mono text-xs text-critical">
          {u.key} = {u.value} can't be applied: {u.reason}
        </p>
      ))}
    </div>
  );
}

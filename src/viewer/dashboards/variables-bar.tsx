import type { Variable } from '../../dashboards/schema.js';
import type { ResourceValues } from '../data/data-source.js';
import type { DashboardPageState } from '../state/dashboard-state.js';

/** The disabled last item of a capped list; never a real value. */
export const MORE = '\u0000more';

export interface Option {
  label: string;
  value: string | null;
  disabled?: boolean;
}

/**
 * "all" first, then the values, then the cap note. The current value and the config's default are listed even when
 * the report has no such value: an option that disappears on selection makes the Select report "all" right after.
 */
export function optionsOf(known: ResourceValues, current: string | null, fallback: string | null): Option[] {
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

/** `vars` with `variable` set to `value`: a choice equal to the config's default is no override at all. */
export function withVariable(
  vars: DashboardPageState['vars'],
  variable: Variable,
  value: string | null,
): DashboardPageState['vars'] {
  const { [variable.key]: _dropped, ...rest } = vars;
  return value === variable.default ? rest : { ...rest, [variable.key]: value };
}

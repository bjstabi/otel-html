import type { JSX } from 'react';
import type { ColorAssigner } from '../theme/palette.js';
import { DEFAULT_GROUP_KEY, type FacetSource, groupSlices } from './facet-views.js';

/** The Table view: a facet's top values and the rest, with counts and shares. Spans and logs both use it. */
export function GroupTable(props: {
  result: FacetSource;
  groupBy: string | null;
  colors: ColorAssigner;
  /** Plural, capitalised: the count column's header ("Spans", "Logs"). */
  noun: string;
}): JSX.Element {
  const key = props.groupBy ?? DEFAULT_GROUP_KEY;
  const slices = groupSlices(props.result.facets, key, props.colors);
  const total = slices.reduce((a, s) => a + s.value, 0);
  return (
    <table className="w-full rounded-card border border-hairline bg-surface text-sm">
      <caption className="sr-only">
        {props.noun} grouped by {key}
      </caption>
      <thead>
        <tr className="border-b border-hairline text-left text-xs text-ink-2">
          <th scope="col" className="p-2">
            {key}
          </th>
          <th scope="col" className="p-2 text-right">
            {props.noun}
          </th>
          <th scope="col" className="p-2 text-right">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {slices.map((s) => (
          <tr
            key={`${s.other ? 'rest' : 'value'}:${s.key}`}
            className="border-b border-hairline last:border-0"
          >
            <td className="p-2 font-mono text-xs">{s.name}</td>
            <td className="p-2 text-right font-mono tabular-nums">{s.value}</td>
            <td className="p-2 text-right font-mono tabular-nums">
              {total === 0 ? '0' : Math.round((s.value / total) * 100)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

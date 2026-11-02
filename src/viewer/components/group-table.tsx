import type { JSX } from 'react';
import type { Measure } from '../../dashboards/schema.js';
import { formatDuration } from '../../semconv/formatters.js';
import type { ColorAssigner } from '../theme/palette.js';
import { DEFAULT_GROUP_KEY, type FacetSource, MEASURE_LABELS, sliceSet } from './facet-views.js';

/** The Table view: a facet's top values and the rest, with counts and shares. Spans and logs both use it. */
export function GroupTable(props: {
  result: FacetSource;
  groupBy: string | null;
  colors: ColorAssigner;
  /** Plural, capitalised: the count column's header ("Spans", "Logs"). */
  noun: string;
  measure: Measure;
}): JSX.Element {
  const key = props.groupBy ?? DEFAULT_GROUP_KEY;
  const { measure } = props;
  const slices = sliceSet(props.result, key, measure, props.colors);
  const timed = measure !== 'count';
  const showShare = measure === 'count' || measure === 'duration.sum';
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
            {timed ? MEASURE_LABELS[measure] : props.noun}
          </th>
          {showShare && (
            <th scope="col" className="p-2 text-right">
              Share
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {slices.map((s) => (
          <tr
            key={`${s.other ? 'rest' : 'value'}:${s.key}`}
            className="border-b border-hairline last:border-0"
          >
            <td className="p-2 font-mono text-xs">{s.name}</td>
            <td className="p-2 text-right font-mono tabular-nums">
              {timed ? formatDuration(s.value) : s.value}
            </td>
            {showShare && (
              <td className="p-2 text-right font-mono tabular-nums">
                {total === 0 ? '0' : Math.round((s.value / total) * 100)}%
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

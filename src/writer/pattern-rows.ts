import { anyValueFromJson } from '../format/columns.js';
import type { Row } from '../format/parquet/rows.js';
import { anyValueToDisplay } from '../model/anyvalue.js';
import type { RelNanos } from '../model/ids.js';
import { Drain, template } from '../rollups/drain.js';
import { severityKey } from '../semconv/severity.js';

interface Group {
  id: number;
  count: number;
  first: bigint | null;
  last: bigint | null;
  severities: Record<string, number>;
  sample: string;
}

const big = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);

/** The text Drain sees for a log row: the same display text the log rollup uses for the record's body. */
function bodyText(row: Row): string {
  const json = Reflect.get(row, 'body');
  return typeof json === 'string' ? anyValueToDisplay(anyValueFromJson(json)) : '';
}

/**
 * Clusters the log bodies of one cut on a working copy of `drain` and returns the `patterns` rows plus the copy.
 * `drain` itself is not touched: the caller adopts the copy only after the cut's files were written, so a retried
 * cut derives the same rows and ids once. One row per cluster that got a log in this cut: `count` is this cut's
 * logs, times are the min/max effective log time (`time_unix_nano`, else observed; null when none), `template` is
 * the cluster's template after the cut, `sample` the first body (taken order) of the cut.
 *
 * The copy goes through `toJSON`/`Drain.from` (the clone Drain has): cost grows with the clusters (at most 2000).
 */
export function patternRows(
  drain: Drain,
  logs: readonly Row[],
  epoch: bigint,
): { rows: Row[]; drain: Drain } {
  const copy = Drain.from(drain.toJSON(), 'drain');
  const groups = new Map<number, Group>();
  for (const l of logs) {
    const text = bodyText(l);
    const sev = Number(Reflect.get(l, 'severity_number') ?? 0);
    const t = big(Reflect.get(l, 'time_unix_nano')) ?? big(Reflect.get(l, 'observed_time_unix_nano'));
    const id = copy.add(text, severityKey(sev), Number((t ?? epoch) - epoch) as RelNanos);
    if (id < 0) continue;
    let g = groups.get(id);
    if (g === undefined) {
      g = { id, count: 0, first: null, last: null, severities: {}, sample: text };
      groups.set(id, g);
    }
    g.count++;
    g.severities[String(sev)] = (g.severities[String(sev)] ?? 0) + 1;
    if (t !== null) {
      if (g.first === null || t < g.first) g.first = t;
      if (g.last === null || t > g.last) g.last = t;
    }
  }
  const clusters = copy.clusters();
  const rows = [...groups.values()]
    .sort((a, b) => a.id - b.id)
    .map((g): Row => {
      const c = clusters[g.id];
      return {
        cluster_id: BigInt(g.id),
        template: c === undefined ? '' : template(c),
        count: BigInt(g.count),
        first_time_unix_nano: g.first,
        last_time_unix_nano: g.last,
        severity_counts: JSON.stringify(g.severities),
        sample: g.sample,
      };
    });
  return { rows, drain: copy };
}

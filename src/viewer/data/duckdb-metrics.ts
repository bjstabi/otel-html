import type { ManifestV4 } from '../../format/manifest.js';
import { OtelHtmlError } from '../../model/errors.js';
import {
  metricDefsQuery,
  metricIdentitiesQuery,
  metricSparkQuery,
  SPARK_BUCKETS,
  summaryQuantilesQuery,
} from '../../query/sql/points.js';
import type { RelWindow } from '../../query/sql/prune.js';
import { bucketSpec } from '../../query/sql/time.js';
import { resourceKey } from './metric-catalog.js';
import { type CatalogRows, catalogFrom, type MetricMethods, summaryShowOptions } from './metric-results.js';
import { kindOf, SHOW_BY_KIND } from './metric-tables.js';
import type { QueryEngine } from './query-engine.js';

export interface MetricContext {
  engine: QueryEngine;
  manifest: ManifestV4;
  epoch: bigint;
  /** The report's time range relative to the epoch. */
  range: RelWindow | null;
}

const notYet = (): OtelHtmlError =>
  new OtelHtmlError('usage', { message: 'Metric queries are not available in this build yet' });

/** The metric data layer over `points` (D20, D30). */
export function metricMethods(ctx: MetricContext): MetricMethods {
  const { engine, epoch, range } = ctx;
  let catalog: Promise<CatalogRows> | null = null;

  const load = async (): Promise<CatalogRows> => {
    const spec = bucketSpec(null, range, SPARK_BUCKETS);
    const [defs, identities, spark] = await Promise.all([
      engine.query(metricDefsQuery()),
      engine.query(metricIdentitiesQuery()),
      engine.query(metricSparkQuery(spec, epoch)),
    ]);
    return catalogFrom(defs, identities, spark, spec);
  };
  const metricCatalog = (): Promise<CatalogRows> => {
    if (catalog === null) {
      const pending = load();
      catalog = pending;
      // a rejection clears the memo so the next call retries
      pending.catch(() => {
        if (catalog === pending) catalog = null;
      });
    }
    return catalog;
  };

  return {
    metricCatalog,
    async metricShowOptions(entryId) {
      const cat = await metricCatalog();
      const entry = cat.entries[entryId];
      const identity = cat.identities[entryId];
      if (entry === undefined || identity === undefined) {
        throw new OtelHtmlError('usage', {
          path: 'metric entry',
          expected: 'an entry of the catalog',
          actual: String(entryId),
        });
      }
      const kind = kindOf(entry);
      if (kind !== 'summary') return SHOW_BY_KIND[kind];
      return summaryShowOptions(await engine.query(summaryQuantilesQuery(identity)));
    },
    metricQuery: () => Promise.reject(notYet()),
    metricRunQuery: () => Promise.reject(notYet()),
    async metricsForResources(resources) {
      const cat = await metricCatalog();
      const keys = new Set(resources.map(resourceKey));
      return cat.entries.filter((e) =>
        e.resources.some((i) => {
          const r = cat.resources[i];
          return r !== undefined && keys.has(resourceKey(r));
        }),
      );
    },
  };
}

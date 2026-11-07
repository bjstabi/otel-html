import type { AnyManifest } from '../../format/manifest.js';
import type { DataSource } from '../data/data-source.js';

/**
 * What the trace panel and its tabs read of a data source. The format-4 `DataSource` provides it, and so does the
 * legacy source (whose `percentileOf` is synchronous) that the logs page and the dashboards still pass, until 5.3
 * and 5.4 move them; then this is `DataSource` again.
 */
export interface TraceSource
  extends Pick<
    DataSource,
    'getTrace' | 'hasTrace' | 'traceLogs' | 'metricCatalog' | 'metric' | 'metricsForResources'
  > {
  readonly manifest: AnyManifest;
  percentileOf(service: string, resource: string, durationNs: number): number | null | Promise<number | null>;
}

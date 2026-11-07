import type { DataSource } from '../data/data-source.js';
import type { MetricSource } from '../metrics/metric-grid.js';
import type { TraceSource } from '../traces/trace-source.js';

/**
 * What the log panel and its tabs read of a data source: the format-4 `DataSource` provides it, and so does the
 * legacy source the dashboards still pass (until 5.4; its `surroundingLogs` has an extra `partial` nobody reads).
 */
export interface LogSource
  extends TraceSource,
    MetricSource,
    Pick<DataSource, 'getLog' | 'hasTrace' | 'surroundingLogs'> {}

import { expectTypeOf, test } from 'vitest';
import type { ResourceRecord, ScopeRecord } from '../../src/model/records.js';
import type { MetricDef as RollupMetricDef } from '../../src/rollups/metric-catalog.js';
import type { MetricDef, MetricEntry } from '../../src/viewer/data/metric-catalog.js';
import type {
  MetricQueryResult as OldMetricQueryResult,
  SeriesPoints as OldSeriesPoints,
} from '../../src/viewer/data/metric-query.js';
import type {
  MetricMethods,
  MetricQueryRequest,
  MetricQueryResult,
  MetricRunQueryRequest,
  RunInfo,
  RunLine,
  RunQueryResult,
  SeriesPoints,
  SeriesRow,
} from '../../src/viewer/data/metric-results.js';
import type {
  RunInfo as OldRunInfo,
  RunLine as OldRunLine,
  RunQueryResult as OldRunQueryResult,
} from '../../src/viewer/data/metric-run-query.js';

// Until PR 5 deletes the originals, the copies must stay the same types.
test('the copied result types equal the originals', () => {
  expectTypeOf<MetricQueryResult>().toEqualTypeOf<OldMetricQueryResult>();
  expectTypeOf<SeriesPoints>().toEqualTypeOf<OldSeriesPoints>();
  expectTypeOf<RunInfo>().toEqualTypeOf<OldRunInfo>();
  expectTypeOf<RunLine>().toEqualTypeOf<OldRunLine>();
  expectTypeOf<RunQueryResult>().toEqualTypeOf<OldRunQueryResult>();
});

test('MetricDef is assignable both ways to the rollups MetricDef', () => {
  expectTypeOf<MetricDef>().toExtend<RollupMetricDef>();
  expectTypeOf<RollupMetricDef>().toExtend<MetricDef>();
});

test('SeriesRow has the decoded series columns', () => {
  expectTypeOf<SeriesRow['seriesId']>().toEqualTypeOf<string>();
  expectTypeOf<SeriesRow['resource']>().toEqualTypeOf<ResourceRecord>();
  expectTypeOf<SeriesRow['scope']>().toEqualTypeOf<ScopeRecord>();
  expectTypeOf<SeriesRow['bounds']>().toEqualTypeOf<number[] | null>();
  expectTypeOf<SeriesRow['groups']>().toEqualTypeOf<(string | null)[]>();
});

test('MetricMethods has the data layer signatures', () => {
  expectTypeOf<MetricMethods['metricCatalog']>().returns.resolves.toExtend<{
    entries: readonly MetricEntry[];
  }>();
  expectTypeOf<MetricMethods['metricShowOptions']>().parameters.toEqualTypeOf<[entryId: number]>();
  expectTypeOf<MetricMethods['metricShowOptions']>().returns.resolves.toEqualTypeOf<readonly string[]>();
  expectTypeOf<MetricMethods['metricQuery']>().parameter(0).toEqualTypeOf<MetricQueryRequest>();
  expectTypeOf<MetricMethods['metricQuery']>().parameter(1).toEqualTypeOf<AbortSignal | undefined>();
  expectTypeOf<MetricMethods['metricQuery']>().returns.resolves.toEqualTypeOf<MetricQueryResult>();
  expectTypeOf<MetricMethods['metricRunQuery']>().parameter(0).toEqualTypeOf<MetricRunQueryRequest>();
  expectTypeOf<MetricMethods['metricRunQuery']>().parameter(1).toEqualTypeOf<AbortSignal | undefined>();
  expectTypeOf<MetricMethods['metricRunQuery']>().returns.resolves.toEqualTypeOf<RunQueryResult>();
  expectTypeOf<MetricMethods['metricsForResources']>().parameters.toEqualTypeOf<
    [resources: readonly ResourceRecord[]]
  >();
  expectTypeOf<MetricMethods['metricsForResources']>().returns.resolves.toEqualTypeOf<
    readonly MetricEntry[]
  >();
});

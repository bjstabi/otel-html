import { expectTypeOf, test } from 'vitest';
import type { ResourceRecord, ScopeRecord } from '../../src/model/records.js';
import type { MetricEntry } from '../../src/viewer/data/metric-catalog.js';
import type {
  MetricMethods,
  MetricQueryRequest,
  MetricQueryResult,
  MetricRunQueryRequest,
  RunQueryResult,
  SeriesRow,
} from '../../src/viewer/data/metric-results.js';

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

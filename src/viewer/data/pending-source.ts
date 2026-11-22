import type { ManifestV4 } from '../../format/manifest.js';
import type { DataSource } from './data-source.js';

type MethodName = {
  [K in keyof DataSource]: DataSource[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof DataSource];

/**
 * A data source whose every query waits for `ready`, the real one. The shell renders before the query engine
 * exists; `App` keeps this as the shown data source, so the page is up while the engine loads. `manifest` is the
 * one the first progress carries, which is also the one the real source gets.
 *
 * A call whose `AbortSignal` is already aborted when `ready` settles rejects with an `AbortError` and queries
 * nothing. A rejected `ready` rejects every call with its error.
 */
export function pendingDataSource(manifest: ManifestV4, ready: Promise<DataSource>): DataSource {
  const after =
    <K extends MethodName>(name: K) =>
    (...args: Parameters<DataSource[K]>): ReturnType<DataSource[K]> =>
      ready.then((ds) => {
        if (args.some((a) => a instanceof AbortSignal && a.aborted)) {
          throw new DOMException('The query was abandoned before the engine was ready', 'AbortError');
        }
        const method = ds[name] as (...a: Parameters<DataSource[K]>) => Promise<unknown>;
        return method.apply(ds, args);
      }) as unknown as ReturnType<DataSource[K]>;
  return {
    manifest,
    epoch: BigInt(manifest.epochUnixNano),
    querySpans: after('querySpans'),
    getTrace: after('getTrace'),
    hasTrace: after('hasTrace'),
    percentileOf: after('percentileOf'),
    serviceShare: after('serviceShare'),
    services: after('services'),
    spanPoints: after('spanPoints'),
    queryLogs: after('queryLogs'),
    logPoints: after('logPoints'),
    getLog: after('getLog'),
    traceLogs: after('traceLogs'),
    surroundingLogs: after('surroundingLogs'),
    patterns: after('patterns'),
    metricPoints: after('metricPoints'),
    resourceValues: after('resourceValues'),
    cicdRows: after('cicdRows'),
    metricCatalog: after('metricCatalog'),
    metricShowOptions: after('metricShowOptions'),
    metricQuery: after('metricQuery'),
    metricRunQuery: after('metricRunQuery'),
    metricsForResources: after('metricsForResources'),
    close: after('close'),
  };
}

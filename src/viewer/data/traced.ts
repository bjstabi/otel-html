import { SpanStatusCode } from '@opentelemetry/api';
import { traced, viewerTracer } from '../telemetry.js';
import type { DataSource } from './data-source.js';
import type { ScriptLoader } from './script-loader.js';

/** Each chunk load as a `viewer.chunk.load` span; a failure is an ERROR span. */
export function tracedLoader(loader: ScriptLoader): ScriptLoader {
  return {
    load: (path, key) =>
      traced('viewer.chunk.load', { 'otel_html.path': path, 'otel_html.key': key }, () =>
        loader.load(path, key),
      ),
  };
}

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

function query<T>(kind: string, count: (r: T) => number, run: () => Promise<T>): Promise<T> {
  return viewerTracer().startActiveSpan(
    'viewer.query',
    { attributes: { 'otel_html.query.kind': kind } },
    async (span) => {
      try {
        const result = await run();
        span.setAttribute('otel_html.query.result_count', count(result));
        return result;
      } catch (e: unknown) {
        // An abort is the viewer superseding its own query, not a failure: the status stays unset.
        if (isAbort(e)) {
          span.setAttribute('otel_html.query.aborted', true);
        } else {
          span.recordException(e instanceof Error ? e : String(e));
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

/** `viewer.query` spans for the data source's query methods; the others pass through. */
export function tracedDataSource(ds: DataSource): DataSource {
  return {
    ...ds,
    querySpans: (q, onProgress, signal) =>
      query(
        'querySpans',
        (r) => r.rows.length,
        () => ds.querySpans(q, onProgress, signal),
      ),
    queryLogs: (q, onProgress, signal) =>
      query(
        'queryLogs',
        (r) => r.rows.length,
        () => ds.queryLogs(q, onProgress, signal),
      ),
    getTrace: (id) =>
      query(
        'getTrace',
        (r) => r.spans.length,
        () => ds.getTrace(id),
      ),
    traceLogs: (id, signal) =>
      query(
        'traceLogs',
        (r) => r.length,
        () => ds.traceLogs(id, signal),
      ),
    surroundingLogs: (ref, n) =>
      query(
        'surroundingLogs',
        (r) => r.before.length + 1 + r.after.length,
        () => ds.surroundingLogs(ref, n),
      ),
    metric: (id) =>
      query(
        'metric',
        (r) => r.series.length,
        () => ds.metric(id),
      ),
    metricsForResources: (resources) =>
      query(
        'metricsForResources',
        (r) => r.length,
        () => ds.metricsForResources(resources),
      ),
  };
}

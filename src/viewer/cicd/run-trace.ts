import type { TraceDetail } from '../data/data-source.js';

const RUN_ID = 'cicd.pipeline.run.id';

/** True when the trace is a CI run: a span with no parent whose resource carries a pipeline run id. */
export function isRunTrace(detail: TraceDetail): boolean {
  return detail.spans.some(
    (r) => r.span.parentSpanId === null && detail.resources(r.span.resource).attributes.has(RUN_ID),
  );
}

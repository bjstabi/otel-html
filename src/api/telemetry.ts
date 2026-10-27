import { type Tracer as OtelTracer, SpanStatusCode } from '@opentelemetry/api';
import type { Tracer } from '../writer/ports.js';

/** Adapts an `@opentelemetry/api` tracer to the writer's self-telemetry port. A no-op until the host registers an SDK. */
export function createOtelTracer(tracer: OtelTracer): Tracer {
  return {
    startSpan(name, attrs = {}) {
      const span = tracer.startSpan(name, { attributes: attrs });
      return {
        setAttributes(a) {
          span.setAttributes(a);
        },
        recordError(error) {
          const exception = error instanceof Error ? error : String(error);
          span.recordException(exception);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
        },
        end() {
          span.end();
        },
      };
    },
  };
}

import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId } from '../../model/ids.js';

export function traceNotFound(traceId: TraceId): OtelHtmlError {
  return new OtelHtmlError('usage', {
    path: `trace ${traceId}`,
    expected: 'a trace listed in the report',
    actual: 'not found',
  });
}

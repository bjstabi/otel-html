import type { ResourceRecord, SpanRecord } from '../model/records.js';
import { ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_ROUTE, ATTR_SERVICE_NAME } from './attributes.js';

export const UNKNOWN_SERVICE = 'unknown_service';

const ATTR_PROCESS_EXECUTABLE_NAME = 'process.executable.name';

/**
 * `service.name` of the resource. Per the OTel resource spec, when it is absent (or not a non-empty string)
 * the name is `unknown_service:<process.executable.name>` if that attribute is set, else `unknown_service`.
 */
export function serviceName(r: ResourceRecord): string {
  const v = r.attributes.get(ATTR_SERVICE_NAME);
  if (v?.kind === 'string' && v.value !== '') return v.value;
  const exe = r.attributes.get(ATTR_PROCESS_EXECUTABLE_NAME);
  return exe?.kind === 'string' && exe.value !== '' ? `${UNKNOWN_SERVICE}:${exe.value}` : UNKNOWN_SERVICE;
}

/** The Resource column: `"<method> <route>"` when both are present, else the span name. */
export function resourceName(span: SpanRecord): string {
  const method = span.attributes.get(ATTR_HTTP_REQUEST_METHOD);
  const route = span.attributes.get(ATTR_HTTP_ROUTE);
  if (method?.kind === 'string' && route?.kind === 'string' && method.value !== '' && route.value !== '') {
    return `${method.value} ${route.value}`;
  }
  return span.name;
}

/** A service entry span has no parent, or a parent in a different service. */
export function isServiceEntry(
  span: SpanRecord,
  parent: SpanRecord | undefined,
  svc: string,
  parentSvc: string | undefined,
): boolean {
  if (span.parentSpanId === null || parent === undefined) return true;
  return svc !== parentSvc;
}

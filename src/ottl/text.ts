import { type Attributes, anyValueToDisplay } from '../model/anyvalue.js';
import type { LogTarget, SpanTarget } from './contexts.js';

/** Free text is a case-insensitive contains-match, not OTTL. Empty text matches everything. */
export function matchesText(text: string, haystack: Iterable<string>): boolean {
  const needle = text.toLowerCase();
  if (needle === '') return true;
  for (const h of haystack) {
    if (h.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function* values(a: Attributes): Iterable<string> {
  for (const v of a.values()) yield anyValueToDisplay(v);
}

/** Span name, status message, and all attribute values (span and resource). Keys are not searched. */
export function* spanTextFields(t: SpanTarget): Iterable<string> {
  yield t.span.name;
  yield t.span.status.message;
  yield* values(t.span.attributes);
  yield* values(t.resource.attributes);
}

/** Body display string, SeverityText, event name, and all attribute values (log and resource). Keys are not searched. */
export function* logTextFields(t: LogTarget): Iterable<string> {
  yield anyValueToDisplay(t.log.body);
  yield t.log.severityText;
  yield t.log.eventName;
  yield* values(t.log.attributes);
  yield* values(t.resource.attributes);
}

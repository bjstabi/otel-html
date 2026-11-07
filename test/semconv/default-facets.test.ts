import { expect, test } from 'vitest';
import { SpanKind } from '../../src/model/records.js';
import type { SpanTarget } from '../../src/ottl/contexts.js';
import { DEFAULT_SPAN_FACETS, SPAN_KIND_NAMES } from '../../src/semconv/default-facets.js';

test('the service facet is a core facet, as the log facet and the facet panel have it', () => {
  expect(DEFAULT_SPAN_FACETS.find((d) => d.key === 'service.name')?.scope).toBe('core');
});

test('the span.kind facet value is SPAN_KIND_NAMES at the kind number', () => {
  const kind = DEFAULT_SPAN_FACETS.find((d) => d.key === 'span.kind');
  for (const k of [
    SpanKind.UNSPECIFIED,
    SpanKind.INTERNAL,
    SpanKind.SERVER,
    SpanKind.CLIENT,
    SpanKind.PRODUCER,
    SpanKind.CONSUMER,
  ])
    expect(kind?.value({ span: { kind: k } } as unknown as SpanTarget)).toBe(SPAN_KIND_NAMES[k]);
});

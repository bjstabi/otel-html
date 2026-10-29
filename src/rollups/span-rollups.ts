import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import { anyValueToDisplay } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';
import { SpanKind, StatusCode } from '../model/records.js';
import type { SpanTarget } from '../ottl/contexts.js';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_HOST_NAME,
  ATTR_SERVICE_NAME,
} from '../semconv/attributes.js';
import { resourceName, serviceName } from '../semconv/resource-name.js';
import { ExpHistogram } from './exp-histogram.js';
import { addFacet, facetableAttributes } from './facet-values.js';
import { FacetCounts } from './facets.js';
import { RedSeries } from './red.js';
import { TimeBuckets } from './time-buckets.js';

export const SPAN_STATUS_KEYS = ['ok', 'error', 'unset'] as const;
export type SpanStatusKey = (typeof SPAN_STATUS_KEYS)[number];

/** Distinct (service, resource) duration histograms kept; further groups are counted in `droppedDurationGroups`. */
export const MAX_DURATION_GROUPS = 10_000;

export function spanKindName(k: SpanKind): string {
  switch (k) {
    case SpanKind.UNSPECIFIED:
      return 'unspecified';
    case SpanKind.INTERNAL:
      return 'internal';
    case SpanKind.SERVER:
      return 'server';
    case SpanKind.CLIENT:
      return 'client';
    case SpanKind.PRODUCER:
      return 'producer';
    case SpanKind.CONSUMER:
      return 'consumer';
  }
}

export function statusKey(c: StatusCode): SpanStatusKey {
  switch (c) {
    case StatusCode.OK:
      return 'ok';
    case StatusCode.ERROR:
      return 'error';
    case StatusCode.UNSET:
      return 'unset';
  }
}

function resourceAttr(t: SpanTarget, key: string): string | undefined {
  const v = t.resource.attributes.get(key);
  return v === undefined ? undefined : anyValueToDisplay(v);
}

export interface CoreFacet {
  readonly key: string;
  readonly label: string;
  readonly value: (t: SpanTarget) => string | undefined;
}

/** Always-tracked facets (exempt from the key cap), in display order. */
export const DEFAULT_SPAN_FACETS: readonly CoreFacet[] = [
  { key: ATTR_SERVICE_NAME, label: 'Service', value: (t) => serviceName(t.resource) },
  { key: 'span.name', label: 'Span name', value: (t) => t.span.name },
  { key: 'span.kind', label: 'Kind', value: (t) => spanKindName(t.span.kind) },
  { key: 'status.code', label: 'Status', value: (t) => statusKey(t.span.status.code) },
  { key: 'resource', label: 'Resource', value: (t) => resourceName(t.span) },
  { key: 'instrumentation_scope.name', label: 'Scope', value: (t) => t.scope.name },
  { key: ATTR_HOST_NAME, label: 'Host', value: (t) => resourceAttr(t, ATTR_HOST_NAME) },
  {
    key: ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
    label: 'Environment',
    value: (t) => resourceAttr(t, ATTR_DEPLOYMENT_ENVIRONMENT_NAME),
  },
];

const CORE_KEYS: ReadonlySet<string> = new Set(DEFAULT_SPAN_FACETS.map((f) => f.key));
/** Default facets whose values are resource attributes (span attributes of these names are not faceted). */
export const SPAN_RESOURCE_FACET_KEYS: ReadonlySet<string> = new Set([
  ATTR_SERVICE_NAME,
  ATTR_HOST_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
]);
const DURATION_KEY_SEP = '\u0000';

export interface SpanRollupOptions {
  readonly facetValueCap: number;
  readonly facetKeyCap: number;
}

const SerializedSpanRollupsSchema = z.strictObject({
  buckets: z.unknown(),
  facets: z.unknown(),
  durations: z.array(z.tuple([z.string(), z.unknown()])),
  droppedDurationGroups: z.number().int().nonnegative(),
  red: z.unknown(),
});

export type SerializedSpanRollups = {
  buckets: ReturnType<TimeBuckets<SpanStatusKey>['toJSON']>;
  facets: ReturnType<FacetCounts['toJSON']>;
  durations: [string, ReturnType<ExpHistogram['toJSON']>][];
  droppedDurationGroups: number;
  red: ReturnType<RedSeries['toJSON']>;
};

export class SpanRollups {
  buckets: TimeBuckets<SpanStatusKey> = new TimeBuckets(SPAN_STATUS_KEYS);
  facets: FacetCounts;
  /** Keyed by `service + "\u0000" + resource`. */
  durations: Map<string, ExpHistogram> = new Map();
  red: RedSeries = new RedSeries();
  droppedDurationGroups: number = 0;

  constructor(opts: SpanRollupOptions) {
    this.facets = new FacetCounts(
      opts.facetValueCap,
      opts.facetKeyCap,
      DEFAULT_SPAN_FACETS.map((f) => f.key),
    );
  }

  add(t: SpanTarget): void {
    const { span } = t;
    const status = statusKey(span.status.code);
    this.buckets.add(span.start, status);
    const duration = Math.max(0, span.end - span.start);
    this.red.add(span.start, duration, status === 'error');

    for (const f of DEFAULT_SPAN_FACETS) {
      const v = f.value(t);
      if (v !== undefined) this.#facet(f.key, v);
    }
    for (const a of facetableAttributes(span.attributes, CORE_KEYS)) this.#facet(a.key, a.value, a.kind);

    const dk = `${serviceName(t.resource)}${DURATION_KEY_SEP}${resourceName(span)}`;
    let h = this.durations.get(dk);
    if (h === undefined) {
      if (this.durations.size >= MAX_DURATION_GROUPS) {
        this.droppedDurationGroups++;
        return;
      }
      h = new ExpHistogram();
      this.durations.set(dk, h);
    }
    h.record(duration);
  }

  #facet(key: string, value: string, kind: 'string' | 'int' | 'double' | 'bool' = 'string'): void {
    addFacet(this.facets, key, value, kind);
  }

  toJSON(): SerializedSpanRollups {
    return {
      buckets: this.buckets.toJSON(),
      facets: this.facets.toJSON(),
      durations: [...this.durations]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, h]) => [k, h.toJSON()]),
      droppedDurationGroups: this.droppedDurationGroups,
      red: this.red.toJSON(),
    };
  }

  static from(input: unknown, opts: SpanRollupOptions, root = 'spans'): SpanRollups {
    const s = parseWith(SerializedSpanRollupsSchema, input, root);
    const r = new SpanRollups(opts);
    r.buckets = TimeBuckets.from(s.buckets, SPAN_STATUS_KEYS, `${root}.buckets`);
    r.facets = FacetCounts.from(s.facets, `${root}.facets`, {
      valueCap: opts.facetValueCap,
      keyCap: opts.facetKeyCap,
    });
    for (const k of DEFAULT_SPAN_FACETS) {
      if (!r.facets.pinned.has(k.key)) {
        throw new OtelHtmlError('invalid-report', {
          path: `${root}.facets.pinned`,
          expected: `pinned core facet ${JSON.stringify(k.key)}`,
          actual: JSON.stringify([...r.facets.pinned]),
        });
      }
    }
    s.durations.forEach(([k, h], i) => {
      r.durations.set(k, ExpHistogram.from(h, `${root}.durations[${i}]`));
    });
    r.droppedDurationGroups = s.droppedDurationGroups;
    r.red = RedSeries.from(s.red, `${root}.red`);
    return r;
  }
}

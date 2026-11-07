import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import { anyValueToDisplay } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';
import type { SpanTarget } from '../ottl/contexts.js';
import { DEFAULT_SPAN_FACETS, SPAN_RESOURCE_FACET_KEYS, statusKey } from '../semconv/default-facets.js';
import { resourceName, serviceName } from '../semconv/resource-name.js';
import { ExpHistogram } from './exp-histogram.js';
import { addFacet, facetableAttributes, scalarKind, truncateFacetValue } from './facet-values.js';
import { FacetCounts } from './facets.js';
import { RedSeries } from './red.js';
import { TimeBuckets } from './time-buckets.js';

const SPAN_STATUS_KEYS = ['ok', 'error', 'unset'] as const;
export type SpanStatusKey = (typeof SPAN_STATUS_KEYS)[number];

/** Distinct (service, resource) duration histograms kept; further groups are counted in `droppedDurationGroups`. */
const MAX_DURATION_GROUPS = 10_000;

// The facet definitions live in src/semconv/default-facets.ts (D16); the chunk writer reads them from here until the chunks go.
export { DEFAULT_SPAN_FACETS, SPAN_RESOURCE_FACET_KEYS };

const CORE_KEYS: ReadonlySet<string> = new Set(DEFAULT_SPAN_FACETS.map((f) => f.key));
/**
 * A reader for the value a span has for a facet key: the default facet's value for a core key, else the span
 * attribute of that name, truncated as `addFacet` truncates. The key is resolved once; the reader returns
 * undefined when the span has none.
 */
export function facetReader(key: string): (t: SpanTarget) => string | undefined {
  const core = DEFAULT_SPAN_FACETS.find((f) => f.key === key);
  if (core !== undefined) {
    return (t) => {
      const v = core.value(t);
      return v === undefined ? undefined : truncateFacetValue(v);
    };
  }
  return (t) => {
    const v = t.span.attributes.get(key);
    return v === undefined || scalarKind(v) === undefined
      ? undefined
      : truncateFacetValue(anyValueToDisplay(v));
  };
}

export function facetValueOf(t: SpanTarget, key: string): string | undefined {
  return facetReader(key)(t);
}

/** One duration histogram per group; groups past `cap` are not kept and their spans are counted in `dropped`. */
export class GroupDurations {
  readonly #groups = new Map<string, ExpHistogram>();
  readonly cap: number;
  #dropped = 0;

  constructor(cap: number) {
    this.cap = cap;
  }

  /** Spans whose group was refused because `cap` groups were already kept. */
  get dropped(): number {
    return this.#dropped;
  }

  get size(): number {
    return this.#groups.size;
  }

  add(group: string, durationNs: number): void {
    let h = this.#groups.get(group);
    if (h === undefined) {
      if (this.#groups.size >= this.cap) {
        this.#dropped++;
        return;
      }
      h = new ExpHistogram();
      this.#groups.set(group, h);
    }
    h.record(durationNs);
  }

  get(group: string): ExpHistogram | undefined {
    return this.#groups.get(group);
  }

  entries(): IterableIterator<[string, ExpHistogram]> {
    return this.#groups.entries();
  }
}

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

  static from(input: unknown, opts: SpanRollupOptions | undefined, root = 'spans'): SpanRollups {
    const s = parseWith(SerializedSpanRollupsSchema, input, root);
    // Without `opts` the facets keep the caps they were written with.
    const facets = FacetCounts.from(
      s.facets,
      `${root}.facets`,
      opts && { valueCap: opts.facetValueCap, keyCap: opts.facetKeyCap },
    );
    const r = new SpanRollups({ facetValueCap: facets.valueCap, facetKeyCap: facets.keyCap });
    r.facets = facets;
    r.buckets = TimeBuckets.from(s.buckets, SPAN_STATUS_KEYS, `${root}.buckets`);
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

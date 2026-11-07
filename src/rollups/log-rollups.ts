import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import { anyValueToDisplay } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';
import { logTime } from '../model/records.js';
import type { LogTarget } from '../ottl/contexts.js';
import { DEFAULT_LOG_FACETS, LOG_RESOURCE_FACET_KEYS } from '../semconv/default-facets.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey, severityKey } from '../semconv/severity.js';
import { Drain, type SerializedDrain } from './drain.js';
import { addFacet, facetableAttributes } from './facet-values.js';
import { FacetCounts } from './facets.js';
import type { SpanRollupOptions } from './span-rollups.js';
import { TimeBuckets } from './time-buckets.js';

// The facet definitions live in src/semconv/default-facets.ts (D16); the chunk writer reads them from here until the chunks go.
export { DEFAULT_LOG_FACETS, LOG_RESOURCE_FACET_KEYS };

const CORE_KEYS: ReadonlySet<string> = new Set(DEFAULT_LOG_FACETS.map((f) => f.key));
const SerializedLogRollupsSchema = z.strictObject({
  buckets: z.unknown(),
  facets: z.unknown(),
  patterns: z.unknown(),
});

export type SerializedLogRollups = {
  buckets: ReturnType<TimeBuckets<LogSeverityKey>['toJSON']>;
  facets: ReturnType<FacetCounts['toJSON']>;
  patterns: SerializedDrain;
};

/** Everything the Logs landing page shows without scanning chunks. */
export class LogRollups {
  buckets: TimeBuckets<LogSeverityKey> = new TimeBuckets(LOG_SEVERITY_KEYS);
  facets: FacetCounts;
  patterns: Drain = new Drain();

  readonly #cluster: boolean;

  /** `cluster: false` skips Drain (the `patterns` stay empty) for callers that never read them. */
  constructor(opts: SpanRollupOptions, { cluster = true }: { cluster?: boolean } = {}) {
    this.#cluster = cluster;
    this.facets = new FacetCounts(
      opts.facetValueCap,
      opts.facetKeyCap,
      DEFAULT_LOG_FACETS.map((f) => f.key),
    );
  }

  add(t: LogTarget): void {
    const { log } = t;
    const severity = severityKey(log.severityNumber);
    const time = logTime(log);
    this.buckets.add(time, severity);
    for (const f of DEFAULT_LOG_FACETS) {
      const v = f.value(t);
      if (v !== undefined) this.#facet(f.key, v);
    }
    for (const a of facetableAttributes(log.attributes, CORE_KEYS)) this.#facet(a.key, a.value, a.kind);
    if (this.#cluster) this.patterns.add(anyValueToDisplay(log.body), severity, time);
  }

  #facet(key: string, value: string, kind: 'string' | 'int' | 'double' | 'bool' = 'string'): void {
    addFacet(this.facets, key, value, kind);
  }

  toJSON(): SerializedLogRollups {
    return { buckets: this.buckets.toJSON(), facets: this.facets.toJSON(), patterns: this.patterns.toJSON() };
  }

  static from(input: unknown, opts: SpanRollupOptions | undefined, root = 'logs'): LogRollups {
    const s = parseWith(SerializedLogRollupsSchema, input, root);
    // Without `opts` the facets keep the caps they were written with.
    const facets = FacetCounts.from(
      s.facets,
      `${root}.facets`,
      opts && { valueCap: opts.facetValueCap, keyCap: opts.facetKeyCap },
    );
    const r = new LogRollups({ facetValueCap: facets.valueCap, facetKeyCap: facets.keyCap });
    r.facets = facets;
    r.buckets = TimeBuckets.from(s.buckets, LOG_SEVERITY_KEYS, `${root}.buckets`);
    for (const k of DEFAULT_LOG_FACETS) {
      if (!r.facets.pinned.has(k.key)) {
        throw new OtelHtmlError('invalid-report', {
          path: `${root}.facets.pinned`,
          expected: `pinned core facet ${JSON.stringify(k.key)}`,
          actual: JSON.stringify([...r.facets.pinned]),
        });
      }
    }
    r.patterns = Drain.from(s.patterns, `${root}.patterns`);
    return r;
  }
}

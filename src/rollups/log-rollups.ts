import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import { anyValueToDisplay } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';
import { logTime } from '../model/records.js';
import type { LogTarget } from '../ottl/contexts.js';
import { ATTR_HOST_NAME, ATTR_SERVICE_NAME } from '../semconv/attributes.js';
import { serviceName } from '../semconv/resource-name.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey, severityKey } from '../semconv/severity.js';
import { Drain, type SerializedDrain } from './drain.js';
import { addFacet, facetableAttributes } from './facet-values.js';
import { FacetCounts } from './facets.js';
import type { SpanRollupOptions } from './span-rollups.js';
import { TimeBuckets } from './time-buckets.js';

export interface LogCoreFacet {
  readonly key: string;
  readonly label: string;
  /** Where the key lives in the data: a resource attribute, or a core log field. */
  readonly scope: 'core' | 'resource';
  /** `undefined` leaves the log out of this facet. */
  readonly value: (t: LogTarget) => string | undefined;
}

/** Always-tracked log facets (exempt from the key cap), in display order. */
export const DEFAULT_LOG_FACETS: readonly LogCoreFacet[] = [
  { key: 'severity', label: 'Severity', scope: 'core', value: (t) => severityKey(t.log.severityNumber) },
  { key: ATTR_SERVICE_NAME, label: 'Service', scope: 'core', value: (t) => serviceName(t.resource) },
  {
    key: ATTR_HOST_NAME,
    label: 'Host',
    scope: 'resource',
    value: (t) => {
      const v = t.resource.attributes.get(ATTR_HOST_NAME);
      return v === undefined ? undefined : anyValueToDisplay(v);
    },
  },
  { key: 'instrumentation_scope.name', label: 'Scope', scope: 'core', value: (t) => t.scope.name },
  {
    key: 'event.name',
    label: 'Event name',
    scope: 'core',
    value: (t) => (t.log.eventName === '' ? undefined : t.log.eventName),
  },
  {
    key: 'trace.present',
    label: 'Has trace',
    scope: 'core',
    value: (t) => (t.log.traceId === null ? 'no' : 'yes'),
  },
];

const CORE_KEYS: ReadonlySet<string> = new Set(DEFAULT_LOG_FACETS.map((f) => f.key));
/** Default facets whose values are resource attributes (log attributes of these names are not faceted). */
export const LOG_RESOURCE_FACET_KEYS: ReadonlySet<string> = new Set([ATTR_SERVICE_NAME, ATTR_HOST_NAME]);

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

  static from(input: unknown, opts: SpanRollupOptions, root = 'logs'): LogRollups {
    const s = parseWith(SerializedLogRollupsSchema, input, root);
    const r = new LogRollups(opts);
    r.buckets = TimeBuckets.from(s.buckets, LOG_SEVERITY_KEYS, `${root}.buckets`);
    r.facets = FacetCounts.from(s.facets, `${root}.facets`, {
      valueCap: opts.facetValueCap,
      keyCap: opts.facetKeyCap,
    });
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

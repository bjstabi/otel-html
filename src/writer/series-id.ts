import { canonicalAttributesKey } from '../model/interner.js';
import type { MetricPointRecord, ResourceRecord, ScopeRecord } from '../model/records.js';
import { boundsOf } from '../rollups/metric-catalog.js';
import { hash32 } from '../rollups/metric-streams.js';

// Four independent 32-bit xor-multiply hashes (FNV-1a basis and prime first), concatenated: 128 bits.
const HASHES: readonly (readonly [number, number])[] = [
  [0x811c9dc5, 0x01000193],
  [0x9747b28c, 0x5bd1e995],
  [0xcbf29ce4, 0x85ebca6b],
  [0x84222325, 0xc2b2ae35],
];

/**
 * The `series_id` of a metric point: a hash of the series' identity, which is its metric (name, type, unit,
 * temporality, monotonicity, and for an explicit histogram its bucket bounds), resource, scope and point attributes. It depends on nothing but the point, so it is the
 * same in every session and partition and the normalizer's saved state needs no catalog. Resource and scope enter
 * with their attributes (keys sorted), not their report-local ids.
 */
export function seriesIdOf(p: MetricPointRecord, resource: ResourceRecord, scope: ScopeRecord): string {
  const identity = JSON.stringify([
    p.name,
    p.type,
    p.unit,
    p.temporality,
    p.monotonic,
    boundsOf(p),
    [resource.schemaUrl, resource.droppedAttributesCount, canonicalAttributesKey(resource.attributes)],
    [
      scope.name,
      scope.version,
      scope.schemaUrl,
      scope.droppedAttributesCount,
      canonicalAttributesKey(scope.attributes),
    ],
    canonicalAttributesKey(p.attributes),
  ]);
  return HASHES.map(([basis, prime]) => hash32(identity, basis, prime)).join('');
}

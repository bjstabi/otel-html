import { canonicalAttributesKey } from '../model/interner.js';
import type { MetricPointRecord, ResourceRecord, ScopeRecord } from '../model/records.js';
import { hash32 } from '../rollups/metric-streams.js';

/** Explicit bucket bounds of a histogram point; `null` for every other type. */
function boundsOf(p: MetricPointRecord): number[] | null {
  if (p.type !== 'histogram') return null;
  const raw: unknown =
    typeof p.point === 'object' && p.point !== null ? Reflect.get(p.point, 'explicitBounds') : [];
  if (!Array.isArray(raw)) return [];
  // Non-finite bounds are malformed points that the stream normalizer rejects; they never name a series.
  return raw.map((b: unknown) => Number(b)).filter((b) => Number.isFinite(b));
}

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
  const head = JSON.stringify([p.name, p.type, p.unit, p.temporality, p.monotonic, boundsOf(p)]).slice(1, -1);
  const identity = `[${head},${resourcePart(resource)},${scopePart(scope)},${JSON.stringify(canonicalAttributesKey(p.attributes))}]`;
  return HASHES.map(([basis, prime]) => hash32(identity, basis, prime)).join('');
}

// The resource and scope parts are the same for every point of a resource or scope, and they are most of the
// identity. A record is interned for the session, so its part is built once; a weak key lets it go with the record.
const RESOURCE_PARTS = new WeakMap<ResourceRecord, string>();
const SCOPE_PARTS = new WeakMap<ScopeRecord, string>();

function resourcePart(resource: ResourceRecord): string {
  let part = RESOURCE_PARTS.get(resource);
  if (part === undefined) {
    part = JSON.stringify([
      resource.schemaUrl,
      resource.droppedAttributesCount,
      canonicalAttributesKey(resource.attributes),
    ]);
    RESOURCE_PARTS.set(resource, part);
  }
  return part;
}

function scopePart(scope: ScopeRecord): string {
  let part = SCOPE_PARTS.get(scope);
  if (part === undefined) {
    part = JSON.stringify([
      scope.name,
      scope.version,
      scope.schemaUrl,
      scope.droppedAttributesCount,
      canonicalAttributesKey(scope.attributes),
    ]);
    SCOPE_PARTS.set(scope, part);
  }
  return part;
}

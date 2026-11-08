import type { MetricPointRecord, ResourceRecord, ScopeRecord } from '../../model/records.js';

/** The viewer's metric catalog (D21): one entry per metric definition in the report. */

export interface MetricDef {
  id: number;
  name: string;
  description: string;
  unit: string;
  type: MetricPointRecord['type'];
  temporality: MetricPointRecord['temporality'];
  monotonic: boolean;
}

/** A metric's point sums and counts per bucket of `widthNs` from `startNs`, for the Catalog's sparkline. */
export interface SparkBuckets {
  widthNs: number;
  startNs: number;
  sums: number[];
  counts: number[];
}

/** `id` is the entry's index in `MetricCatalogData.entries`; `conflicting` is true when another entry shares the name. */
export interface MetricEntry extends MetricDef {
  conflicting: boolean;
  scopes: string[];
  attributeKeys: string[];
  resources: number[];
  series: number;
  points: number;
  resets: number;
  outOfOrder: number;
  noValue: number;
  spark: SparkBuckets;
}

/** Entries are ordered by name, type, unit, temporality, monotonic. */
export interface MetricCatalogData {
  entries: readonly MetricEntry[];
  resources: readonly ResourceRecord[];
  scopes: readonly ScopeRecord[];
}

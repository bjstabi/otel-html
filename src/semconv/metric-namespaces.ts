/** Metric namespaces in the order the catalog lists them; unknown ones follow alphabetically, `other` last. */
export const NAMESPACE_ORDER: readonly string[] = [
  'process',
  'system',
  'runtime',
  'jvm',
  'nodejs',
  'http',
  'rpc',
  'db',
  'messaging',
  'faas',
  'container',
  'k8s',
  'gen_ai',
];

const OTHER = 'other';

/** The prefix of a metric name before its first `.`, or `other` when there is none. */
export function metricNamespace(name: string): string {
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : OTHER;
}

function rank(ns: string): number {
  if (ns === OTHER) return Number.MAX_SAFE_INTEGER;
  const i = NAMESPACE_ORDER.indexOf(ns);
  return i < 0 ? NAMESPACE_ORDER.length : i;
}

/** Sort comparator for namespaces. */
export function compareNamespaces(a: string, b: string): number {
  const d = rank(a) - rank(b);
  return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
}

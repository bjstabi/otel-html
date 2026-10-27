import type { AnyValue, Attributes } from '../model/anyvalue.js';

/** Attribute namespaces, in display order. A key belongs to a group when it equals the prefix or starts with `prefix.`. */
export const SEMCONV_GROUPS: readonly { readonly prefix: string; readonly label: string }[] = [
  { prefix: 'http', label: 'HTTP' },
  { prefix: 'url', label: 'URL' },
  { prefix: 'server', label: 'Server' },
  { prefix: 'client', label: 'Client' },
  { prefix: 'network', label: 'Network' },
  { prefix: 'db', label: 'Database' },
  { prefix: 'rpc', label: 'RPC' },
  { prefix: 'messaging', label: 'Messaging' },
  { prefix: 'gen_ai', label: 'Generative AI' },
  { prefix: 'faas', label: 'FaaS' },
  { prefix: 'exception', label: 'Exception' },
  { prefix: 'error', label: 'Error' },
  { prefix: 'code', label: 'Code' },
  { prefix: 'thread', label: 'Thread' },
  { prefix: 'user_agent', label: 'User agent' },
  { prefix: 'k8s', label: 'Kubernetes' },
  { prefix: 'host', label: 'Host' },
  { prefix: 'os', label: 'OS' },
  { prefix: 'process', label: 'Process' },
  { prefix: 'service', label: 'Service' },
  { prefix: 'telemetry', label: 'Telemetry' },
  { prefix: 'cloud', label: 'Cloud' },
  { prefix: 'container', label: 'Container' },
  { prefix: 'deployment', label: 'Deployment' },
];

export const OTHER_GROUP_LABEL = 'Other';

export interface AttributeGroup {
  readonly label: string;
  readonly entries: [string, AnyValue][];
}

function groupLabel(key: string): string {
  for (const g of SEMCONV_GROUPS) {
    if (key === g.prefix || key.startsWith(`${g.prefix}.`)) return g.label;
  }
  return OTHER_GROUP_LABEL;
}

/** Group attributes by semconv namespace: table order, "Other" last, entries sorted by key. Empty groups are omitted. */
export function groupAttributes(a: Attributes): AttributeGroup[] {
  const byLabel = new Map<string, [string, AnyValue][]>();
  for (const [k, v] of a) {
    const label = groupLabel(k);
    const list = byLabel.get(label);
    if (list === undefined) byLabel.set(label, [[k, v]]);
    else list.push([k, v]);
  }
  const out: AttributeGroup[] = [];
  for (const label of [...SEMCONV_GROUPS.map((g) => g.label), OTHER_GROUP_LABEL]) {
    const entries = byLabel.get(label);
    if (entries === undefined) continue;
    entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    out.push({ label, entries });
  }
  return out;
}

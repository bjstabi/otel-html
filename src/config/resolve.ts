import { Document, Scalar, stringify, YAMLSeq } from 'yaml';
import { OtelHtmlError } from '../model/errors.js';
import { ENV_BINDINGS } from './env.js';
import { type ConfigInput, ConfigSchema, type ResolvedConfig } from './schema.js';

export type ConfigSource = 'default' | 'file' | 'env' | 'flag';

export interface ResolveLayers {
  file?: unknown;
  env: Readonly<Record<string, string | undefined>>;
  flags?: ConfigInput;
}

export interface ResolveResult {
  config: ResolvedConfig;
  sources: ReadonlyMap<string, ConfigSource>;
}

type Tree = { [key: string]: unknown };

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isTree(v: unknown): v is Tree {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Leaf paths (arrays and scalars are leaves) of a plain-object tree. */
function leaves(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isTree(v)) {
    for (const [k, child] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) {
        throw new OtelHtmlError('invalid-config', {
          path: prefix === '' ? k : `${prefix}.${k}`,
          message: `${prefix === '' ? k : `${prefix}.${k}`}: unrecognized key`,
        });
      }
      if (child !== undefined) leaves(child, prefix === '' ? k : `${prefix}.${k}`, out);
    }
  } else if (prefix !== '') {
    out.set(prefix, v);
  }
}

function setPath(root: Tree, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    const next = Object.hasOwn(cur, part) ? cur[part] : undefined;
    if (isTree(next)) cur = next;
    else {
      const created: Tree = {};
      cur[part] = created;
      cur = created;
    }
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) cur[last] = value;
}

function envLayer(env: Readonly<Record<string, string | undefined>>): Tree {
  const out: Tree = {};
  for (const b of ENV_BINDINGS) {
    const raw = env[b.env];
    if (raw === undefined) continue;
    if (b.parse === 'int') {
      if (!/^\d+$/.test(raw.trim())) {
        throw new OtelHtmlError('invalid-config', {
          path: b.env,
          expected: `integer (for ${b.path})`,
          actual: JSON.stringify(raw),
        });
      }
      setPath(out, b.path, Number(raw.trim()));
    } else {
      setPath(out, b.path, raw);
    }
  }
  return out;
}

export function resolveConfig(layers: ResolveLayers): ResolveResult {
  const ordered: [ConfigSource, unknown][] = [
    ['file', layers.file],
    ['env', envLayer(layers.env)],
    ['flag', layers.flags],
  ];
  const merged = new Map<string, unknown>();
  const origin = new Map<string, ConfigSource>();
  for (const [source, layer] of ordered) {
    if (layer === undefined) continue;
    if (!isTree(layer)) {
      throw new OtelHtmlError('invalid-config', {
        path: source,
        expected: 'object',
        actual: JSON.stringify(layer),
      });
    }
    const found = new Map<string, unknown>();
    leaves(layer, '', found);
    for (const [p, v] of found) {
      merged.set(p, v);
      origin.set(p, source);
    }
  }
  const raw: Tree = {};
  for (const [p, v] of merged) setPath(raw, p, v);

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines: string[] = [];
    for (const issue of parsed.error.issues) {
      const base = issue.path.map(String).join('.');
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) lines.push(`${base === '' ? key : `${base}.${key}`}: unrecognized key`);
      } else {
        lines.push(`${base === '' ? '(root)' : base}: ${issue.message}`);
      }
    }
    throw new OtelHtmlError('invalid-config', { message: lines.join('\n') });
  }

  const sources = new Map<string, ConfigSource>();
  const all = new Map<string, unknown>();
  leaves(parsed.data, '', all);
  for (const p of all.keys()) sources.set(p, origin.get(p) ?? 'default');
  return { config: parsed.data, sources };
}

/** Renders the resolved config as YAML, each leaf annotated with `# from: <source>`. */
export function formatConfig(resolved: ResolveResult): string {
  const doc = new Document(resolved.config);
  const annotate = (node: unknown, path: string): void => {
    if (node instanceof Scalar || node instanceof YAMLSeq) {
      node.comment = ` from: ${resolved.sources.get(path) ?? 'default'}`;
      return;
    }
    if (node !== null && typeof node === 'object' && 'items' in node && Array.isArray(node.items)) {
      for (const pair of node.items) {
        if (pair !== null && typeof pair === 'object' && 'key' in pair && 'value' in pair) {
          const key = pair.key instanceof Scalar ? String(pair.key.value) : '';
          annotate(pair.value, path === '' ? key : `${path}.${key}`);
        }
      }
    }
  };
  annotate(doc.contents, '');
  return stringify(doc);
}

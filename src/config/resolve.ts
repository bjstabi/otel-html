import { Document, Scalar, stringify, YAMLMap, YAMLSeq } from 'yaml';
import { OtelHtmlError } from '../model/errors.js';
import { ENV_BINDINGS } from './env.js';
import { type ConfigInput, ConfigSchema, type ResolvedConfig } from './schema.js';

export type ConfigSource = 'default' | 'file' | 'env' | 'flag';

export interface ResolveLayers {
  file?: unknown;
  env: Readonly<Record<string, string | undefined>>;
  flags?: ConfigInput;
  /** Names the file in each dashboard's `source` (default `config file`). */
  fileLabel?: string;
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

type Leaves = Map<string, { path: readonly string[]; value: unknown }>;

/** Leaf paths (arrays and scalars are leaves) of a plain-object tree, keyed by `JSON.stringify(path)`. */
function leaves(v: unknown, prefix: readonly string[], out: Leaves): void {
  if (isTree(v)) {
    for (const [k, child] of Object.entries(v)) {
      const path = [...prefix, k];
      if (FORBIDDEN_KEYS.has(k)) {
        throw new OtelHtmlError('invalid-config', {
          path: path.join('.'),
          message: `${path.join('.')}: unrecognized key`,
        });
      }
      if (child !== undefined) leaves(child, path, out);
    }
  } else if (prefix.length > 0) {
    out.set(JSON.stringify(prefix), { path: prefix, value: v });
  }
}

/** Sets a value at a path of parts (never split, so a key containing a dot stays one key). */
function setPath(root: Tree, parts: readonly string[], value: unknown): void {
  let cur = root;
  for (const [i, part] of parts.slice(0, -1).entries()) {
    const existing = Object.hasOwn(cur, part) ? cur[part] : undefined;
    if (isTree(existing)) cur = existing;
    else if (existing !== undefined) {
      throw new OtelHtmlError('invalid-config', {
        path: parts.slice(0, i + 1).join('.'),
        expected: 'object',
        actual: JSON.stringify(existing),
      });
    } else {
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
      setPath(out, b.path.split('.'), Number(raw.trim()));
    } else {
      setPath(out, b.path.split('.'), raw);
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
  const merged: Leaves = new Map();
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
    const found: Leaves = new Map();
    leaves(layer, [], found);
    for (const [key, leaf] of found) {
      merged.set(key, leaf);
      origin.set(key, source);
    }
  }
  const raw: Tree = {};
  for (const { path, value } of merged.values()) setPath(raw, path, value);

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

  // The one place a dashboard's source is named: the file (by its label), else the library API's flags.
  const label =
    origin.get(JSON.stringify(['dashboards'])) === 'file'
      ? (layers.fileLabel ?? 'config file')
      : 'library API';
  for (const d of parsed.data.dashboards) d.source = label;

  const sources = new Map<string, ConfigSource>();
  const all: Leaves = new Map();
  leaves(parsed.data, [], all);
  for (const [key, { path }] of all) sources.set(path.join('.'), origin.get(key) ?? 'default');
  return { config: parsed.data, sources };
}

/** Renders the resolved config as YAML, each leaf annotated with `# from: <source>`. */
export function formatConfig(resolved: ResolveResult): string {
  // Dashboards print as they are written (`{ id, title, widgets }`), each with a `# source:` comment, not as their
  // resolved `{ source, dashboard }`.
  const { config } = resolved;
  const doc = new Document({ ...config, dashboards: config.dashboards.map((d) => d.dashboard) });
  const dashboards = doc.get('dashboards');
  if (dashboards instanceof YAMLSeq) {
    dashboards.items.forEach((item, i) => {
      const source = config.dashboards[i]?.source;
      if (item instanceof YAMLMap && source !== undefined) item.commentBefore = ` source: ${source}`;
    });
  }
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

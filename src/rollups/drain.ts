import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import type { RelNanos } from '../model/ids.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey } from './signal-counts.js';

/** Drain parameters; they are stored with the clusters so a change can never silently mix clusterings. */
export const DRAIN_PARAMS = {
  depth: 4,
  similarity: 0.4,
  maxChildren: 100,
  maxClusters: 2000,
  maxTokens: 64,
} as const;

export const WILDCARD = '<*>';

const SAMPLE_CHARS = 256;

/** Whole-token masks: a token matching any of these is replaced by the wildcard before clustering. */
export const DRAIN_MASKS: readonly RegExp[] = [
  /^[-+]?\d+(\.\d+)?$/,
  /^(0x)?[0-9a-f]{8,}$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/,
];

export type DrainCluster = {
  id: number;
  tokens: string[];
  truncated: boolean;
  count: number;
  severities: Record<LogSeverityKey, number>;
  first: number;
  last: number;
  sample: string;
};

export type SerializedDrain = {
  params: typeof DRAIN_PARAMS;
  unclustered: number;
  clusters: DrainCluster[];
};

/** Split on whitespace runs, mask variable tokens, and keep the first `maxTokens`. */
export function tokenize(body: string): { tokens: string[]; truncated: boolean } {
  const trimmed = body.trim();
  const all = trimmed === '' ? [] : trimmed.split(/\s+/);
  const truncated = all.length > DRAIN_PARAMS.maxTokens;
  const tokens = (truncated ? all.slice(0, DRAIN_PARAMS.maxTokens) : all).map((t) =>
    DRAIN_MASKS.some((m) => m.test(t)) ? WILDCARD : t,
  );
  return { tokens, truncated };
}

/** The cluster's template text: tokens joined by one space, plus ` …` when the body was cut. */
export function template(c: DrainCluster): string {
  return c.truncated ? `${c.tokens.join(' ')} …` : c.tokens.join(' ');
}

/** The first body seen, cut to `SAMPLE_CHARS` without splitting a surrogate pair. */
function cutSample(body: string): string {
  let end = SAMPLE_CHARS;
  const last = body.charCodeAt(end - 1);
  if (body.length > end && last >= 0xd800 && last <= 0xdbff) end--;
  return body.slice(0, end);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** A regex source matching every member of the cluster (open-ended when the template was truncated). */
export function templateToRegex(c: DrainCluster): string {
  const body = c.tokens.map((t) => (t === WILDCARD ? '\\S+' : escapeRegex(t))).join('\\s+');
  return c.truncated ? `^${body}` : `^${body}$`;
}

const nonNegInt: z.ZodNumber = z.number().int().nonnegative();

const DrainClusterSchema: z.ZodType<DrainCluster> = z.strictObject({
  id: nonNegInt,
  tokens: z.array(z.string()).max(DRAIN_PARAMS.maxTokens),
  truncated: z.boolean(),
  count: nonNegInt,
  severities: z.record(z.enum(LOG_SEVERITY_KEYS), nonNegInt),
  first: z.number(),
  last: z.number(),
  sample: z.string().max(SAMPLE_CHARS),
});

const SerializedDrainSchema: z.ZodType<SerializedDrain> = z
  .strictObject({
    params: z.strictObject({
      depth: z.literal(DRAIN_PARAMS.depth),
      similarity: z.literal(DRAIN_PARAMS.similarity),
      maxChildren: z.literal(DRAIN_PARAMS.maxChildren),
      maxClusters: z.literal(DRAIN_PARAMS.maxClusters),
      maxTokens: z.literal(DRAIN_PARAMS.maxTokens),
    }),
    unclustered: nonNegInt,
    clusters: z.array(DrainClusterSchema).max(DRAIN_PARAMS.maxClusters),
  })
  .refine((s) => s.clusters.every((c, i) => c.id === i), {
    message: 'cluster ids 0..n-1 in order',
    path: ['clusters'],
  });

interface Node {
  readonly children: Map<string, Node>;
  readonly clusters: DrainCluster[];
}

const newNode = (): Node => ({ children: new Map(), clusters: [] });
const hasDigit = (t: string): boolean => /\d/.test(t);

function zeroSeverities(): Record<LogSeverityKey, number> {
  return { unspecified: 0, trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
}

/** Share of positions where the cluster holds a literal token equal to the message's; wildcards do not count. */
function similarity(c: readonly string[], tokens: readonly string[]): number {
  if (tokens.length === 0) return 1;
  let same = 0;
  for (let i = 0; i < tokens.length; i++) if (c[i] !== WILDCARD && c[i] === tokens[i]) same++;
  return same / tokens.length;
}

/** Classic Drain online log-template miner: fixed-depth prefix tree, then similarity within a leaf. */
export class Drain {
  unclustered = 0;
  readonly #roots = new Map<number, Node>();
  readonly #clusters: DrainCluster[] = [];

  /** Cluster `body`; returns its cluster id, or -1 once `maxClusters` is reached and no cluster fits. */
  add(body: string, severity: LogSeverityKey, time: RelNanos): number {
    const { tokens, truncated } = tokenize(body);
    const atCap = this.#clusters.length >= DRAIN_PARAMS.maxClusters;
    const leaf = this.#leaf(tokens, !atCap);
    let best: DrainCluster | undefined;
    let bestSim = -1;
    for (const c of leaf?.clusters ?? []) {
      const s = similarity(c.tokens, tokens);
      if (s > bestSim) {
        best = c;
        bestSim = s;
      }
    }
    let target = best;
    if (target !== undefined && bestSim >= DRAIN_PARAMS.similarity) {
      for (let i = 0; i < tokens.length; i++) if (target.tokens[i] !== tokens[i]) target.tokens[i] = WILDCARD;
      target.truncated ||= truncated;
      target.first = Math.min(target.first, time);
      target.last = Math.max(target.last, time);
    } else {
      if (leaf === undefined || atCap) {
        this.unclustered++;
        return -1;
      }
      target = {
        id: this.#clusters.length,
        tokens,
        truncated,
        count: 0,
        severities: zeroSeverities(),
        first: time,
        last: time,
        sample: cutSample(body),
      };
      this.#clusters.push(target);
      leaf.clusters.push(target);
    }
    target.count++;
    target.severities[severity]++;
    return target.id;
  }

  clusters(): readonly DrainCluster[] {
    return this.#clusters;
  }

  /** The leaf for `tokens`; without `create` the tree is left untouched and a missing path falls back to `<*>`. */
  #leaf(tokens: readonly string[], create: true): Node;
  #leaf(tokens: readonly string[], create: boolean): Node | undefined;
  #leaf(tokens: readonly string[], create: boolean): Node | undefined {
    let node = this.#roots.get(tokens.length);
    if (node === undefined) {
      if (!create) return undefined;
      node = newNode();
      this.#roots.set(tokens.length, node);
    }
    const layers = Math.min(DRAIN_PARAMS.depth - 2, tokens.length);
    for (let i = 0; i < layers; i++) {
      const t = tokens[i] ?? WILDCARD;
      let key = hasDigit(t) ? WILDCARD : t;
      if (!node.children.has(key) && key !== WILDCARD && node.children.size >= DRAIN_PARAMS.maxChildren) {
        key = WILDCARD;
      }
      let next = node.children.get(key);
      if (next === undefined && !create) next = node.children.get(WILDCARD);
      if (next === undefined) {
        if (!create) return undefined;
        next = newNode();
        node.children.set(key, next);
      }
      node = next;
    }
    return node;
  }

  toJSON(): SerializedDrain {
    return {
      params: DRAIN_PARAMS,
      unclustered: this.unclustered,
      clusters: this.#clusters.map((c) => ({ ...c, tokens: [...c.tokens], severities: { ...c.severities } })),
    };
  }

  /** Rebuild from JSON by re-inserting the clusters in id order. */
  static from(input: unknown, root: string): Drain {
    const s = parseWith(SerializedDrainSchema, input, root);
    const d = new Drain();
    d.unclustered = s.unclustered;
    for (const c of s.clusters) {
      const copy: DrainCluster = { ...c, tokens: [...c.tokens], severities: { ...c.severities } };
      d.#clusters.push(copy);
      d.#leaf(copy.tokens, true).clusters.push(copy);
    }
    return d;
  }
}

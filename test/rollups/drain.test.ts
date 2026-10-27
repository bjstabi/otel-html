import { describe, expect, it } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import {
  DRAIN_PARAMS,
  Drain,
  type DrainCluster,
  template,
  templateToRegex,
  tokenize,
} from '../../src/rollups/drain.js';
import { medianMs } from '../../test-support/median-ms.js';

const { OTEL_HTML_PERF_FACTOR } = process.env;
const PERF_FACTOR = Number(OTEL_HTML_PERF_FACTOR ?? '1');
const t = (n: number): RelNanos => n as RelNanos;

/** A distinct digit-free word per `n` (base 26). */
function letters(n: number): string {
  let out = '';
  let rest = n;
  do {
    out += String.fromCharCode(97 + (rest % 26));
    rest = Math.floor(rest / 26);
  } while (rest > 0);
  return out;
}

function first(d: Drain): DrainCluster {
  const c = d.clusters().at(0);
  if (c === undefined) throw new Error('expected a cluster');
  return c;
}

function clusterOf(body: string): DrainCluster {
  const d = new Drain();
  d.add(body, 'info', t(0));
  return first(d);
}

describe('Drain', () => {
  it('the Drain paper example clusters to one template', () => {
    const d = new Drain();
    for (const n of [4, 5, 6]) d.add(`Receive from node ${n}`, 'info', t(0));
    expect(d.clusters().map(template)).toEqual(['Receive from node <*>']);
    expect(first(d).count).toBe(3);
  });

  it('different shapes stay apart and ids are stable', () => {
    const d = new Drain();
    expect(d.add('card declined: 402 decline_code=insufficient_funds', 'error', t(1))).toBe(0);
    expect(d.add('retrying charge in 200ms (attempt 1/3)', 'warn', t(2))).toBe(1);
    expect(d.add('card declined: 402 decline_code=do_not_honor', 'error', t(3))).toBe(0);
    expect(template(first(d))).toBe('card declined: <*> <*>');
    expect(first(d).severities.error).toBe(2);
    expect([first(d).first, first(d).last]).toEqual([1, 3]);
  });

  it('masks numbers, hex ids, uuids and ip:port as whole tokens', () => {
    expect(
      tokenize('user 42 at 10.0.0.1:8080 req 5b8efff798038103 id 123e4567-e89b-12d3-a456-426614174000')
        .tokens,
    ).toEqual(['user', '<*>', 'at', '<*>', 'req', '<*>', 'id', '<*>']);
  });

  it('long bodies are truncated for clustering and the regex is open-ended', () => {
    const c = clusterOf(Array.from({ length: 100 }, (_, i) => `w${i}`).join(' '));
    expect(c.truncated).toBe(true);
    expect(c.tokens).toHaveLength(DRAIN_PARAMS.maxTokens);
    expect(template(c).endsWith(' …')).toBe(true);
    expect(templateToRegex(c).endsWith('$')).toBe(false);
  });

  it('templateToRegex matches every member and escapes metacharacters', () => {
    const d = new Drain();
    d.add('GET /a?x=1 (ok) 12', 'info', t(0));
    d.add('GET /a?x=1 (ok) 99', 'info', t(0));
    const re = new RegExp(templateToRegex(first(d)));
    expect(re.test('GET /a?x=1 (ok) 7')).toBe(true);
    expect(re.test('GET /aXx=1 (ok) 7')).toBe(false);
  });

  it('maxClusters caps clusters and counts the rest', () => {
    const d = new Drain();
    const ids: number[] = [];
    for (let i = 0; i <= DRAIN_PARAMS.maxClusters; i++) ids.push(d.add(letters(i), 'info', t(0)));
    expect(d.clusters()).toHaveLength(DRAIN_PARAMS.maxClusters);
    expect(d.unclustered).toBe(1);
    expect(ids.at(-1)).toBe(-1);
  });

  it('round-trips through toJSON/from and keeps clustering identically', () => {
    const a = new Drain();
    a.add('connection from 10.0.0.1:80 closed', 'info', t(1));
    a.add('disk full on volume data', 'error', t(2));
    const b = Drain.from(JSON.parse(JSON.stringify(a)), 'rollups.logs.patterns');
    expect(b.toJSON()).toEqual(a.toJSON());
    for (const d of [a, b]) {
      d.add('connection from 10.0.0.2:81 closed', 'info', t(3));
      d.add('something else entirely here', 'warn', t(4));
    }
    expect(b.toJSON()).toEqual(a.toJSON());
  });

  it('from rejects malformed state with an invalid-report path', () => {
    expect(() => Drain.from({ clusters: 'x' }, 'rollups.logs.patterns')).toThrowError(
      /rollups\.logs\.patterns/,
    );
    const bad = { ...new Drain().toJSON(), params: { ...DRAIN_PARAMS, similarity: 0.5 } };
    expect(() => Drain.from(bad, 'rollups.logs.patterns')).toThrowError(/params\.similarity/);
  });

  it('clusters 200k bodies of 50 shapes within budget', () => {
    const shapes = Array.from(
      { length: 50 },
      (_, s) => `service s${s} handled request ${'k'.repeat(s + 1)} in`,
    );
    const { ms } = medianMs(() => {
      const d = new Drain();
      for (let i = 0; i < 200_000; i++) d.add(`${shapes[i % 50]} ${i}ms id=${i}`, 'info', t(i));
      return d;
    }, 3);
    expect(ms).toBeLessThan(1000 * PERF_FACTOR);
  });
});

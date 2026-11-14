import type { AnyValue } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';
import { attributesFromJson } from './columns.js';

/**
 * One span as the service share sees it. `start` and `end` are relative to the trace's own earliest start, computed by
 * the caller from int64 times, so they are exact; `durationNs` is `end - start` clamped at 0.
 */
export interface ShareSpan {
  spanId: string;
  parentId: string | null;
  service: string;
  start: number;
  end: number;
  durationNs: number;
  provisional: boolean;
}

/** The attribute the CI publisher sets on a span it wrote before the span ended (`PROVISIONAL_ATTR` in src/cli/ci/workflow-trace.ts). */
export const PROVISIONAL_ATTR = 'otel_html.ci.provisional';

/** The one rule for "provisional": the attribute's value is the boolean true. */
export function isProvisionalValue(v: AnyValue | undefined): boolean {
  return v?.kind === 'bool' && v.value;
}

/** Whether a span's attributes JSON (the `attributes` column) marks it provisional; anything but a JSON string is not. */
export function isProvisional(attributesJson: unknown): boolean {
  if (typeof attributesJson !== 'string' || !attributesJson.includes(PROVISIONAL_ATTR)) return false;
  return isProvisionalValue(attributesFromJson(attributesJson).get(PROVISIONAL_ATTR));
}

/** Exclusive time per service, largest first, ties by service name. Totals are exact; drawing converts to `number`. */
export type ServiceShare = readonly { service: string; ns: bigint }[];

/** §5.5: of two copies of one span id, true when the later one (`b`) wins: `a` is provisional and `b` is not, or both are alike and `b` ends later. */
export function laterCopyWins(
  a: { provisional: boolean; end: number },
  b: { provisional: boolean; end: number },
): boolean {
  if (a.provisional !== b.provisional) return a.provisional;
  return b.end > a.end;
}

/** A span's own time: its duration minus the time covered by its children (clipped to the span, overlaps counted once). Children are in start order. */
export function exclusiveNsOf(span: ShareSpan, children: readonly ShareSpan[]): bigint {
  let covered = 0;
  let cursor = span.start;
  for (const c of children) {
    const from = Math.max(c.start, cursor);
    const to = Math.min(c.end, span.end);
    if (to > from) {
      covered += to - from;
      cursor = to;
    }
  }
  const own = BigInt(span.durationNs) - BigInt(covered);
  return own > 0n ? own : 0n;
}

function byStart(a: ShareSpan, b: ShareSpan): number {
  return a.start - b.start || (a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0);
}

/**
 * Exclusive time per service of one trace. Copies of a span id collapse to one (the non-provisional one, else the
 * later end, else the first); a span whose parent is absent is a root; parent cycles are broken by promoting the
 * earliest-starting unreached span, as the viewer's trace tree does.
 */
export function serviceShareOf(spans: readonly ShareSpan[]): ServiceShare {
  const kept = new Map<string, ShareSpan>();
  for (const s of spans) {
    const had = kept.get(s.spanId);
    kept.set(s.spanId, had === undefined || laterCopyWins(had, s) ? s : had);
  }
  const sorted = [...kept.values()].sort(byStart);
  const candidates = new Map<string, ShareSpan[]>();
  const roots: ShareSpan[] = [];
  for (const s of sorted) {
    const parent = s.parentId === null ? undefined : kept.get(s.parentId);
    if (parent === undefined) {
      roots.push(s);
      continue;
    }
    if (parent === s) continue;
    const list = candidates.get(parent.spanId);
    if (list === undefined) candidates.set(parent.spanId, [s]);
    else list.push(s);
  }
  const totals = new Map<string, bigint>();
  const visited = new Set<ShareSpan>();
  const walk = (root: ShareSpan): void => {
    visited.add(root);
    const stack = [root];
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      const children: ShareSpan[] = [];
      for (const c of candidates.get(n.spanId) ?? []) {
        if (visited.has(c)) continue;
        visited.add(c);
        children.push(c);
        stack.push(c);
      }
      totals.set(n.service, (totals.get(n.service) ?? 0n) + exclusiveNsOf(n, children));
    }
  };
  for (const r of roots) walk(r);
  for (const s of sorted) if (!visited.has(s)) walk(s);
  return [...totals]
    .map(([service, ns]) => ({ service, ns }))
    .sort(
      (a, b) =>
        (a.ns === b.ns ? 0 : a.ns > b.ns ? -1 : 1) ||
        (a.service < b.service ? -1 : a.service > b.service ? 1 : 0),
    );
}

/** `[["api","70"],["db","30"]]`: the totals as decimal strings, so no digit is lost. */
export function encodeServiceShare(s: ServiceShare): string {
  return JSON.stringify(s.map((e) => [e.service, e.ns.toString()]));
}

function malformed(text: string): OtelHtmlError {
  const shown = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return new OtelHtmlError('invalid-report', {
    path: 'service_share',
    expected: 'a JSON array of [service, decimal nanoseconds] pairs',
    actual: shown,
  });
}

/** Inverse of `encodeServiceShare`. Throws `invalid-report` on malformed text. */
export function decodeServiceShare(text: string): ServiceShare {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed(text);
  }
  if (!Array.isArray(parsed)) throw malformed(text);
  return parsed.map((e: unknown) => {
    if (
      !Array.isArray(e) ||
      e.length !== 2 ||
      typeof e[0] !== 'string' ||
      typeof e[1] !== 'string' ||
      !/^[0-9]+$/.test(e[1])
    )
      throw malformed(text);
    return { service: e[0], ns: BigInt(e[1]) };
  });
}

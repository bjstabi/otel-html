import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ResourceRef, ScopeRecord, ScopeRef } from '../../model/records.js';
import type { TraceDetail } from './data-source.js';
import type { LoadedChunk, SpanEntry, SpanRow } from './span-query.js';
import { buildTraceTree } from './trace-tree.js';

export function traceNotFound(traceId: TraceId): OtelHtmlError {
  return new OtelHtmlError('usage', {
    path: `trace ${traceId}`,
    expected: 'a trace listed in the report',
    actual: 'not found',
  });
}

/** Assemble a trace from entries of any number of chunks, rebasing chunk-local refs onto shared tables. */
export function assembleTrace(traceId: TraceId, entries: readonly SpanEntry[]): TraceDetail {
  if (entries.length === 0) throw traceNotFound(traceId);
  const offsets = new Map<LoadedChunk, { resource: number; scope: number }>();
  const resources: ResourceRecord[] = [];
  const scopes: ScopeRecord[] = [];
  for (const { chunk } of entries) {
    if (offsets.has(chunk)) continue;
    offsets.set(chunk, { resource: resources.length, scope: scopes.length });
    resources.push(...chunk.resources);
    scopes.push(...chunk.scopes);
  }
  const spans = entries.map(({ row, chunk }): SpanRow => {
    const o = offsets.get(chunk);
    if (o === undefined) throw new Error('invariant violated: chunk offsets');
    return {
      ...row,
      span: {
        ...row.span,
        resource: (row.span.resource + o.resource) as ResourceRef,
        scope: (row.span.scope + o.scope) as ScopeRef,
      },
    };
  });
  const lookup = <T>(table: readonly T[], i: number, what: string): T => {
    const v = table[i];
    if (v === undefined) {
      throw new OtelHtmlError('usage', {
        path: what,
        expected: `a ref in [0, ${table.length})`,
        actual: String(i),
      });
    }
    return v;
  };
  return {
    traceId,
    spans,
    tree: buildTraceTree(spans),
    resources: (r) => lookup(resources, r, 'resource ref'),
    scopes: (s) => lookup(scopes, s, 'scope ref'),
  };
}

import { describe, expect, test } from 'vitest';
import type { RelNanos, SpanId, TraceId } from '../../src/model/ids.js';
import { type ResourceRef, type ScopeRef, type SpanRecord, StatusCode } from '../../src/model/records.js';
import type { SpanRow } from '../../src/viewer/data/span-query.js';
import { buildTraceTree, exclusiveTimeByService } from '../../src/viewer/data/trace-tree.js';

const id = (n: number): SpanId => n.toString(16).padStart(16, '0') as SpanId;

function row(n: number, parent: number | null, start: number, end: number, service = 's'): SpanRow {
  const span: SpanRecord = {
    traceId: 'a'.repeat(32) as TraceId,
    spanId: id(n),
    parentSpanId: parent === null ? null : id(parent),
    traceState: '',
    flags: 0,
    name: `n${n}`,
    kind: 1,
    start: start as RelNanos,
    end: end as RelNanos,
    attributes: new Map(),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: StatusCode.UNSET, message: '' },
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
  };
  return { span, service, resource: span.name, durationNs: end - start };
}

const names = (nodes: readonly { row: SpanRow }[]): string[] => nodes.map((n) => n.row.span.name);

describe('buildTraceTree', () => {
  test('nests children by start and records depth', () => {
    const t = buildTraceTree([row(3, 1, 30, 40), row(1, null, 0, 100), row(2, 1, 10, 20), row(4, 2, 12, 15)]);
    expect(names(t.roots)).toEqual(['n1']);
    expect(names(t.roots[0]?.children ?? [])).toEqual(['n2', 'n3']);
    expect(t.byId.get(id(4))?.depth).toBe(2);
  });

  test('a missing parent yields an extra root and keeps every span', () => {
    const t = buildTraceTree([row(1, null, 0, 100), row(2, 1, 10, 20), row(3, 99, 5, 8), row(4, 3, 6, 7)]);
    expect(names(t.roots)).toEqual(['n1', 'n3']);
    expect(t.byId.size).toBe(4);
    expect(names(t.byId.get(id(3))?.children ?? [])).toEqual(['n4']);
  });

  test('a child starting before its parent stays under the parent', () => {
    const t = buildTraceTree([row(1, null, 50, 100), row(2, 1, 10, 60)]);
    expect(names(t.roots)).toEqual(['n1']);
    expect(names(t.roots[0]?.children ?? [])).toEqual(['n2']);
  });

  test('parent cycles are broken deterministically and keep every span', () => {
    const rows = [row(1, 2, 0, 10), row(2, 1, 5, 9), row(3, 2, 6, 8), row(4, 4, 7, 8), row(5, null, 1, 2)];
    const t = buildTraceTree(rows);
    expect(names(t.roots)).toEqual(['n1', 'n5', 'n4']);
    expect(names(t.byId.get(id(1))?.children ?? [])).toEqual(['n2']);
    expect(names(t.byId.get(id(2))?.children ?? [])).toEqual(['n3']);
    let count = 0;
    const walk = (ns: readonly { children: readonly unknown[] }[]): void => {
      for (const n of ns) {
        count++;
        walk(n.children as typeof ns);
      }
    };
    walk(t.roots);
    expect(count).toBe(5);
    expect(names(buildTraceTree([...rows].reverse()).roots)).toEqual(['n1', 'n5', 'n4']);
  });

  test('a very deep chain neither hangs nor overflows the stack', () => {
    const n = 50_000;
    const rows = Array.from({ length: n }, (_, i) => row(i + 1, i === 0 ? null : i, i, i + 1));
    const t = buildTraceTree(rows);
    expect(t.roots).toHaveLength(1);
    expect(t.byId.get(id(n))?.depth).toBe(n - 1);
    expect(exclusiveTimeByService(t)).toEqual([{ service: 's', ns: n }]);
  });
});

describe('exclusiveTimeByService', () => {
  test('subtracts child time once even when children overlap or overrun the parent', () => {
    const t = buildTraceTree([
      row(1, null, 0, 100, 'a'),
      row(2, 1, 10, 50, 'b'),
      row(3, 1, 30, 70, 'b'),
      row(4, 1, 90, 150, 'c'),
    ]);
    // a: 100 - (10..70 = 60) - (90..100 = 10) = 30; b: 40 + 40; c: 60
    expect(exclusiveTimeByService(t)).toEqual([
      { service: 'b', ns: 80 },
      { service: 'c', ns: 60 },
      { service: 'a', ns: 30 },
    ]);
  });
});

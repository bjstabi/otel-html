import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import type { Attributes } from '../../src/model/anyvalue.js';
import { SpanKind, type SpanRecord, StatusCode } from '../../src/model/records.js';
import type { SpanTarget } from '../../src/ottl/contexts.js';
import { SpanRollups } from '../../src/rollups/span-rollups.js';
import { FacetPanel } from '../../src/viewer/components/facet-panel.js';
import { querySpanEntries, type SpanEntry } from '../../src/viewer/data/span-query.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { spanTarget } from '../ottl/fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const attrs = (o: Attributes): Attributes => o;

function target(name: string, over: Partial<SpanRecord>): SpanTarget {
  return spanTarget({ name, ...over });
}

const TARGETS: SpanTarget[] = [
  target('a', {
    kind: SpanKind.SERVER,
    status: { code: StatusCode.ERROR, message: 'x' },
    attributes: attrs(
      new Map([
        ['http.response.status_code', { kind: 'int', value: 200n }],
        ['retry', { kind: 'bool', value: true }],
        ['ratio', { kind: 'double', value: 0.5 }],
        ['route', { kind: 'string', value: '/a' }],
      ]),
    ),
  }),
  target('b', {
    kind: SpanKind.CLIENT,
    status: { code: StatusCode.OK, message: '' },
    attributes: attrs(
      new Map([
        ['http.response.status_code', { kind: 'int', value: 503n }],
        ['retry', { kind: 'bool', value: false }],
        ['ratio', { kind: 'double', value: 1.5 }],
        ['route', { kind: 'string', value: '/b' }],
      ]),
    ),
  }),
  target('c', {
    kind: SpanKind.SERVER,
    status: { code: StatusCode.UNSET, message: '' },
    attributes: attrs(
      new Map([
        ['http.response.status_code', { kind: 'int', value: 200n }],
        ['retry', { kind: 'bool', value: true }],
        ['ratio', { kind: 'double', value: 0.5 }],
        ['route', { kind: 'string', value: '/c' }],
      ]),
    ),
  }),
];

function rollups(): SpanRollups {
  const r = new SpanRollups({ facetValueCap: 20, facetKeyCap: 50 });
  for (const t of TARGETS) r.add(t);
  return r;
}

function matches(condition: string | null): string[] {
  const entries: SpanEntry[] = TARGETS.map((target) => ({
    row: { span: target.span, service: 'checkout', resource: target.span.name, durationNs: 1 },
    target,
    chunk: { n: 0, resources: [], scopes: [] },
  }));
  const r = querySpanEntries(entries, {
    condition,
    text: '',
    window: null,
    mode: 'spans',
    sort: { column: 'name', dir: 'asc' },
    limit: 100,
    groupBy: null,
    scanAll: false,
  });
  return (r.rows as readonly { span: SpanRecord }[]).map((x) => x.span.name);
}

async function clickOnly(key: string, value: string, label = `Only ${value}`): Promise<string | null> {
  const f = rollups().facets;
  const store = createSelectionStore({});
  render(
    <SelectionProvider store={store}>
      <FacetPanel signal="span" facets={f} />
    </SelectionProvider>,
  );
  // attribute keys are paged; reveal everything
  const more = screen.queryByRole('button', { name: /show more|add/i });
  if (more) await userEvent.click(more);
  expect(key).toBeTruthy();
  await userEvent.click(screen.getAllByRole('button', { name: label })[0] as HTMLElement);
  return store.getState().condition;
}

describe('facet clicks write conditions that match the facet value', () => {
  test('Only error keeps exactly the error spans (display value to enum)', async () => {
    const c = await clickOnly('status.code', 'error');
    expect(matches(c)).toEqual(['a']);
  });

  test('exclude error drops exactly the error spans', () => {
    const store = createSelectionStore({});
    store.getState().toggleFacet('status.code', 'error', 'exclude');
    expect(matches(store.getState().condition)).toEqual(['b', 'c']);
  });

  test('Only server keeps the server spans', async () => {
    const c = await clickOnly('span.kind', 'server');
    expect(matches(c)).toEqual(['a', 'c']);
  });

  test('a core enum facet round-trips to include state in the panel', async () => {
    const store = createSelectionStore({});
    store.getState().toggleFacet('status.code', 'error', 'include');
    render(
      <SelectionProvider store={store}>
        <FacetPanel signal="span" facets={rollups().facets} />
      </SelectionProvider>,
    );
    expect(screen.getByTestId('facet-row:status.code:error').getAttribute('data-state')).toBe('include');
  });

  test.each([
    ['http.response.status_code', '200', ['a', 'c']],
    ['retry', 'true', ['a', 'c']],
    ['ratio', '1.5', ['b']],
    ['route', '/b', ['b']],
  ])('a typed attribute facet %s = %s matches the right spans', (key, value, expected) => {
    const f = rollups().facets;
    const store = createSelectionStore({});
    store.getState().toggleFacet(key, value, 'include', 'attribute', f.kind(key));
    expect(matches(store.getState().condition)).toEqual(expected);
  });

  test('Only 200 on an int attribute through the panel matches', async () => {
    const f = rollups().facets;
    const store = createSelectionStore({});
    render(
      <SelectionProvider store={store}>
        <FacetPanel signal="span" facets={f} attributePageSize={10} />
      </SelectionProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Only 200' }));
    expect(matches(store.getState().condition)).toEqual(['a', 'c']);
  });
});

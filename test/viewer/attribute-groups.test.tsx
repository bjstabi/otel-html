import { Tooltip } from '@base-ui/react/tooltip';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import type { AnyValue, Attributes } from '../../src/model/anyvalue.js';
import type { RelNanos, SpanId, TraceId } from '../../src/model/ids.js';
import type { SpanLinkRecord } from '../../src/model/records.js';
import { addAttributeFilter } from '../../src/viewer/components/attribute-filter.js';
import { AttributeGroups, PINS_STORAGE_KEY } from '../../src/viewer/components/attribute-groups.js';
import { ottlToTokens } from '../../src/viewer/components/filter-tokens.js';
import type { DataSource, TraceDetail } from '../../src/viewer/data/data-source.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { SpanSection } from '../../src/viewer/traces/span-section.js';
import { detailOf, spanIdOf, str, traceRow } from './trace-rows.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const attrs = (o: Record<string, AnyValue>): Attributes => new Map(Object.entries(o));
const headings = (): string[] => screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent ?? '');

describe('AttributeGroups', () => {
  test('groups in SEMCONV_GROUPS order with Other last', () => {
    render(
      <AttributeGroups
        attributes={attrs({
          'custom.key': str('x'),
          'db.system.name': str('postgresql'),
          'url.full': str('http://a/b'),
          'http.request.method': str('GET'),
        })}
        pinned={[]}
      />,
    );
    expect(headings()).toEqual(['HTTP', 'URL', 'Database', 'Other']);
  });

  test('pinned attributes come first, in their own group', () => {
    render(
      <AttributeGroups
        attributes={attrs({ 'http.route': str('/r'), 'db.system.name': str('pg') })}
        pinned={['db.system.name']}
      />,
    );
    expect(headings()).toEqual(['Pinned', 'HTTP']);
  });

  test('dotted keys nest under shared segments', () => {
    render(
      <AttributeGroups
        attributes={attrs({
          'http.request.method': str('GET'),
          'http.request.body.size': str('3'),
          'http.route': str('/r'),
        })}
        pinned={[]}
      />,
    );
    const group = screen.getByRole('group', { name: 'HTTP' });
    expect(within(group).getAllByRole('listitem').length).toBeGreaterThan(3);
    expect(within(group).getByText('GET')).toBeTruthy();
    expect(group.querySelector('[data-key="http.request.method"]')).not.toBeNull();
  });

  test('actions call onFilter, onExclude and copy', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    const onExclude = vi.fn();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(
      <AttributeGroups
        attributes={attrs({ 'http.route': str('/api/cart') })}
        pinned={[]}
        onFilter={onFilter}
        onExclude={onExclude}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Filter http.route to /api/cart' }));
    expect(onFilter).toHaveBeenCalledWith('http.route', { kind: 'string', value: '/api/cart' });
    await user.click(screen.getByRole('button', { name: 'Exclude http.route /api/cart' }));
    expect(onExclude).toHaveBeenCalledWith('http.route', { kind: 'string', value: '/api/cart' });
    await user.click(screen.getByRole('button', { name: 'Copy value of http.route' }));
    expect(writeText).toHaveBeenCalledWith('/api/cart');
    vi.unstubAllGlobals();
  });

  test('values are text nodes: hostile markup never becomes elements', () => {
    const { container } = render(
      <AttributeGroups
        attributes={attrs({ 'custom.x': str('<img src=x onerror="window.__pwned=1">') })}
        pinned={[]}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
  });

  test('kvlist values render as a collapsible JSON tree', () => {
    const nested: AnyValue = {
      kind: 'kvlist',
      values: attrs({ a: { kind: 'kvlist', values: attrs({ b: str('deep') }) } }),
    };
    render(<AttributeGroups attributes={attrs({ 'custom.blob': nested })} pinned={[]} />);
    expect(screen.getByText(/deep/)).toBeTruthy();
  });
});

const manifest = {
  formatVersion: 1,
  epochUnixNano: '1700000000000000000',
} as unknown as Manifest;

function source(over: Partial<DataSource> = {}): DataSource {
  return {
    manifest,
    strategy: 'eager',
    getTrace: () => Promise.reject(new Error('not found')),
    hasTrace: () => Promise.resolve(false),
    percentileOf: () => 90,
    ...over,
  } as DataSource;
}

function mountSection(detail: TraceDetail, spanId: SpanId, ds: DataSource = source(), init = {}) {
  const store = createSelectionStore({ span: spanId, ...init });
  render(
    <ThemeProvider>
      <SelectionProvider store={store}>
        <Tooltip.Provider>
          <SpanSection
            detail={detail}
            spanId={spanId}
            epoch={1_700_000_000_000_000_000n as never}
            dataSource={ds}
          />
        </Tooltip.Provider>
      </SelectionProvider>
    </ThemeProvider>,
  );
  return store;
}

function withSpan(
  extra: Partial<ReturnType<typeof traceRow>['span']>,
  a: Attributes = new Map(),
): TraceDetail {
  const row = traceRow(1, null, 1_000, 5_000_000, { service: 'web', attributes: a });
  return detailOf([{ ...row, span: { ...row.span, ...extra } }]);
}

describe('SpanSection', () => {
  test('without a selected span it prompts', () => {
    const store = createSelectionStore({});
    render(
      <ThemeProvider>
        <SelectionProvider store={store}>
          <SpanSection detail={withSpan({})} spanId={null} epoch={0n as never} dataSource={source()} />
        </SelectionProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText(/Select a span/)).toBeTruthy();
  });

  test('header shows name, service, percentile, duration and share of trace', () => {
    mountSection(withSpan({ name: 'GET /cart' }), spanIdOf(1));
    const header = screen.getByTestId('span-header');
    expect(header.textContent).toContain('GET /cart');
    expect(header.textContent).toContain('web');
    expect(header.textContent).toContain('p90');
    expect(header.textContent).toContain('5 ms');
    expect(header.textContent).toContain('100% of trace');
  });

  test('an exception event renders before the attribute groups, with a collapsible stack trace', async () => {
    const user = userEvent.setup();
    const ev = {
      time: 2_000 as RelNanos,
      name: 'exception',
      attributes: attrs({
        'exception.type': str('TypeError'),
        'exception.message': str('bad <b>thing</b>'),
        'exception.stacktrace': str('at foo (a.js:1)\nat bar (b.js:2)'),
      }),
      droppedAttributesCount: 0,
    };
    mountSection(withSpan({ events: [ev] }, attrs({ 'http.route': str('/r') })), spanIdOf(1));
    const exc = screen.getByTestId('span-exceptions');
    const groups = screen.getByRole('group', { name: 'HTTP' });
    expect(exc.compareDocumentPosition(groups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(exc.textContent).toContain('TypeError');
    expect(exc.textContent).toContain('bad <b>thing</b>');
    expect(exc.querySelector('b')).toBeNull();
    const toggle = within(exc).getByRole('button', { name: /stack trace/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/at foo/)).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/at foo/)).toBeTruthy();
  });

  test('clicking filter on http.route adds the == token to the store', async () => {
    const user = userEvent.setup();
    const store = mountSection(withSpan({}, attrs({ 'http.route': str('/api/cart') })), spanIdOf(1));
    await user.click(screen.getByRole('button', { name: 'Filter http.route to /api/cart' }));
    expect(store.getState().condition).toBe('span.attributes["http.route"] == "/api/cart"');
    await user.click(screen.getByRole('button', { name: 'Exclude http.route /api/cart' }));
    expect(store.getState().condition).toBe('span.attributes["http.route"] != "/api/cart"');
  });

  test('pins persist in localStorage and the section works when storage throws', async () => {
    const user = userEvent.setup();
    mountSection(withSpan({}, attrs({ 'http.route': str('/r') })), spanIdOf(1));
    await user.click(screen.getByRole('button', { name: 'Pin http.route' }));
    expect(window.localStorage.getItem(PINS_STORAGE_KEY)).toContain('http.route');
    expect(headings()[0]).toBe('Pinned');
    cleanup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mountSection(withSpan({}, attrs({ 'http.route': str('/r') })), spanIdOf(1));
    await user.click(screen.getByRole('button', { name: 'Pin http.route' }));
    expect(headings()[0]).toBe('Pinned');
  });

  test('tabs: events and links appear only when present, and show offsets', async () => {
    const user = userEvent.setup();
    const ev = {
      time: 1_501_000 as RelNanos,
      name: 'cache.miss',
      attributes: attrs({ 'custom.k': str('v') }),
      droppedAttributesCount: 0,
    };
    mountSection(withSpan({ events: [ev] }), spanIdOf(1));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Events', 'Resource']);
    await user.click(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByText('cache.miss')).toBeTruthy();
    expect(screen.getByText('+1.5 ms')).toBeTruthy();
  });

  test('links: absent trace says not in this report, present trace is a hash link', async () => {
    const user = userEvent.setup();
    const other = 'b'.repeat(32) as TraceId;
    const missing = 'c'.repeat(32) as TraceId;
    const mk = (t: TraceId): SpanLinkRecord => ({
      traceId: t,
      spanId: spanIdOf(9),
      traceState: '',
      attributes: new Map(),
      droppedAttributesCount: 0,
      flags: 0,
    });
    const ds = source({
      hasTrace: (t: TraceId) => Promise.resolve(t === other),
      getTrace: () => Promise.reject(new Error('links must not load whole traces')),
    });
    mountSection(withSpan({ links: [mk(other), mk(missing)] }), spanIdOf(1), ds);
    await user.click(screen.getByRole('tab', { name: 'Links' }));
    const open = await screen.findByRole('link', { name: /Open trace b{32}/ });
    expect(open.getAttribute('href')).toContain(`#/traces/trace/${other}`);
    await waitFor(() => expect(screen.getByText('not in this report')).toBeTruthy());
    expect(screen.getAllByText('not in this report')).toHaveLength(1);
  });

  test('resource tab shows resource and scope attributes, schema urls and dropped counts', async () => {
    const user = userEvent.setup();
    const detail = {
      ...withSpan({ droppedAttributesCount: 3, droppedEventsCount: 2, droppedLinksCount: 1 }),
      resources: () => ({
        attributes: attrs({ 'service.name': str('web') }),
        droppedAttributesCount: 4,
        schemaUrl: 'https://opentelemetry.io/schemas/1.30.0',
      }),
      scopes: () => ({
        name: 'my-lib',
        version: '1.2.3',
        attributes: new Map(),
        droppedAttributesCount: 0,
        schemaUrl: 'https://example.test/scope-schema',
      }),
    } as TraceDetail;
    mountSection(detail, spanIdOf(1));
    await user.click(screen.getByRole('tab', { name: 'Resource' }));
    const panel = screen.getByRole('tabpanel');
    expect(panel.textContent).toContain('https://opentelemetry.io/schemas/1.30.0');
    expect(panel.textContent).toContain('https://example.test/scope-schema');
    expect(panel.textContent).toContain('my-lib');
    const dropped = within(panel).getByRole('region', { name: 'Dropped counts' });
    expect(dropped.textContent).toMatch(/Span attributes\s*3/);
    expect(dropped.textContent).toMatch(/Events\s*2/);
    expect(dropped.textContent).toMatch(/Links\s*1/);
    expect(dropped.textContent).toMatch(/Resource attributes\s*4/);
  });
});

describe('event and link attributes', () => {
  test('are copy-only: a span-attribute filter would match the wrong thing', async () => {
    const user = userEvent.setup();
    const ev = {
      time: 1_000 as RelNanos,
      name: 'e',
      attributes: attrs({ 'exception.type': str('Boom') }),
      droppedAttributesCount: 0,
    };
    const link: SpanLinkRecord = {
      traceId: 'b'.repeat(32) as TraceId,
      spanId: spanIdOf(9),
      traceState: '',
      attributes: attrs({ 'link.note': str('n') }),
      droppedAttributesCount: 0,
      flags: 0,
    };
    mountSection(withSpan({ events: [ev], links: [link] }), spanIdOf(1));
    await user.click(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByRole('button', { name: 'Copy value of exception.type' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Filter|^Exclude/ })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Links' }));
    expect(screen.getByRole('button', { name: 'Copy value of link.note' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Filter|^Exclude/ })).toBeNull();
  });

  test('a failing presence check says could not check, and is probed once per trace', async () => {
    const user = userEvent.setup();
    const t = 'd'.repeat(32) as TraceId;
    const mk = (n: number): SpanLinkRecord => ({
      traceId: t,
      spanId: spanIdOf(n),
      traceState: '',
      attributes: new Map(),
      droppedAttributesCount: 0,
      flags: 0,
    });
    const hasTrace = vi.fn(() => Promise.reject(new Error('chunk load failed')));
    mountSection(withSpan({ links: [mk(8), mk(9)] }), spanIdOf(1), source({ hasTrace }));
    await user.click(screen.getByRole('tab', { name: 'Links' }));
    await waitFor(() => expect(screen.getAllByText('could not check')).toHaveLength(2));
    expect(screen.queryByText('not in this report')).toBeNull();
    expect(hasTrace).toHaveBeenCalledTimes(1);
  });
});

describe('addAttributeFilter', () => {
  const add = (v: AnyValue, op: '==' | '!=' = '=='): string | null =>
    addAttributeFilter(null, 'attribute', 'k', v, op);

  test('keeps int, bool and double typed', () => {
    expect(add({ kind: 'int', value: 42n })).toBe('span.attributes["k"] == 42');
    expect(add({ kind: 'bool', value: true })).toBe('span.attributes["k"] == true');
    expect(add({ kind: 'double', value: 1.5 }, '!=')).toBe('span.attributes["k"] != 1.5');
  });

  test('escapes quotes, backslashes, newlines and U+2028, and the result round-trips', () => {
    for (const raw of ['a"b', 'a\\b', 'a\nb', 'a\u2028b']) {
      const out = add(str(raw));
      expect(out).not.toBeNull();
      expect(ottlToTokens(out ?? '')).toEqual([{ key: 'span.attributes["k"]', op: '==', value: raw }]);
    }
  });

  test('resource scope uses resource.attributes', () => {
    expect(addAttributeFilter(null, 'resource', 'service.name', str('web'), '==')).toBe(
      'resource.attributes["service.name"] == "web"',
    );
  });

  test('a non-flat condition throws instead of being overwritten', () => {
    expect(() => addAttributeFilter('a == 1 or b == 2', 'attribute', 'k', str('v'), '==')).toThrow(
      /flat `and`/,
    );
  });

  test('non-scalar values are not filterable and leave the condition alone', () => {
    expect(addAttributeFilter('x == 1', 'attribute', 'k', { kind: 'array', values: [] }, '==')).toBe(
      'x == 1',
    );
  });
});

describe('SpanSection filter errors', () => {
  test('a non-flat existing condition shows an alert and is kept', async () => {
    const user = userEvent.setup();
    const store = mountSection(withSpan({}, attrs({ 'http.route': str('/r') })), spanIdOf(1), source(), {
      q: 'attributes["a"] == "1" or attributes["b"] == "2"',
    });
    const before = store.getState().condition;
    await user.click(screen.getByRole('button', { name: 'Filter http.route to /r' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/flat/);
    expect(store.getState().condition).toBe(before);
  });
});

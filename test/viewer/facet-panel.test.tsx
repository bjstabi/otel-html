import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { FacetCounts } from '../../src/rollups/facets.js';
import { FacetPanel } from '../../src/viewer/components/facet-panel.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const HOSTILE = '</script><img src=x onerror=alert(1)> ';

function facets(): FacetCounts {
  const f = new FacetCounts(100, 50, ['service.name', 'status.code', 'host.name']);
  for (const [k, v, n] of [
    ['service.name', 'checkout', 6],
    ['service.name', 'cart', 3],
    ['status.code', 'ok', 8],
    ['status.code', 'error', 1],
    ['host.name', 'h1', 2],
    ['http.method', 'GET', 4],
    ['http.method', HOSTILE, 1],
  ] as const) {
    for (let i = 0; i < n; i++) f.add(k, v);
  }
  return f;
}

function setup(q?: string, props: Partial<Parameters<typeof FacetPanel>[0]> = {}) {
  const store = createSelectionStore(q === undefined ? {} : { q });
  const utils = render(
    <SelectionProvider store={store}>
      <FacetPanel signal="span" facets={facets()} {...props} />
    </SelectionProvider>,
  );
  return { store, ...utils };
}

describe('FacetPanel', () => {
  test('groups Core / Resource / Attributes with counts and share', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Core' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Resource' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Attributes' })).toBeTruthy();
    const row = screen.getByTestId('facet-row:service.name:checkout');
    expect(within(row).getByText('6')).toBeTruthy();
    expect(within(row).getByText('67%')).toBeTruthy();
  });

  test('only sets one include token for the key, replacing other tokens on that key', async () => {
    const user = userEvent.setup();
    const { store } = setup(
      'resource.attributes["service.name"] == "cart" and span.attributes["http.method"] == "GET"',
    );
    await user.click(screen.getByRole('button', { name: 'Only checkout' }));
    expect(store.getState().condition).toBe(
      'span.attributes["http.method"] == "GET" and resource.attributes["service.name"] == "checkout"',
    );
  });

  test('exclude adds a != token; a resource-group key writes a resource attribute path', async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await user.click(screen.getByRole('button', { name: 'Exclude cart' }));
    await user.click(screen.getByRole('button', { name: 'Only h1' }));
    expect(store.getState().condition).toBe(
      'resource.attributes["service.name"] != "cart" and resource.attributes["host.name"] == "h1"',
    );
  });

  test('a raw non-flat condition shows a message and is left untouched', async () => {
    const user = userEvent.setup();
    const q = 'span.name == "a" or span.name == "b"';
    const { store } = setup(q);
    await user.click(screen.getByRole('button', { name: 'Only checkout' }));
    expect(screen.getByRole('alert').textContent).toMatch(/raw OTTL/);
    expect(store.getState().condition).toBe(q);
    await user.click(screen.getByRole('button', { name: 'Exclude cart' }));
    expect(store.getState().condition).toBe(q);
  });

  test('value search filters rows', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search facet values' }), 'chec');
    expect(screen.queryByTestId('facet-row:service.name:cart')).toBeNull();
    expect(screen.getByTestId('facet-row:service.name:checkout')).toBeTruthy();
  });

  test('N of M shown with Add reveals more attribute keys', async () => {
    const user = userEvent.setup();
    const f = new FacetCounts(100, 50, ['service.name']);
    for (let i = 0; i < 7; i++) f.add(`attr${i}`, 'v');
    const store = createSelectionStore({});
    render(
      <SelectionProvider store={store}>
        <FacetPanel signal="span" facets={f} attributePageSize={3} />
      </SelectionProvider>,
    );
    expect(screen.getByText('3 of 7 shown')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('6 of 7 shown')).toBeTruthy();
  });

  test('error status shows a hatch marker and attacker strings render only as text', () => {
    const { container } = setup();
    expect(screen.getByTestId('facet-row:status.code:error').querySelector('[data-hatch]')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(HOSTILE, { normalizer: (t) => t })).toBeTruthy();
  });

  test('duration range writes span duration tokens, replacing earlier ones', async () => {
    const user = userEvent.setup();
    const bins = [
      { fromNs: 0, toNs: 1_000_000, count: 5 },
      { fromNs: 1_000_000, toNs: 10_000_000, count: 3 },
      { fromNs: 10_000_000, toNs: 100_000_000, count: 1 },
    ];
    const { store } = setup('span.name == "a"', { durationBins: bins });
    const min = screen.getByRole('slider', { name: 'Minimum duration' });
    await user.click(min);
    await user.keyboard('{ArrowRight}');
    expect(store.getState().condition).toBe(
      'span.name == "a" and span.end_time_unix_nano - span.start_time_unix_nano >= 1000000',
    );
    await user.keyboard('{ArrowRight}');
    expect(store.getState().condition).toBe(
      'span.name == "a" and span.end_time_unix_nano - span.start_time_unix_nano >= 10000000',
    );
  });

  test('search finds values beyond the top 8 and keeps counts honest', async () => {
    const user = userEvent.setup();
    const f = new FacetCounts(100, 50, ['service.name']);
    for (let i = 0; i < 12; i++)
      for (let n = 0; n < 20 - i; n++) f.add('service.name', `svc-${String(i).padStart(2, '0')}`);
    f.add('http.route', 'only-in-route');
    const store = createSelectionStore({});
    render(
      <SelectionProvider store={store}>
        <FacetPanel signal="span" facets={f} />
      </SelectionProvider>,
    );
    expect(screen.queryByTestId('facet-row:service.name:svc-11')).toBeNull();
    await user.type(screen.getByRole('searchbox', { name: 'Search facet values' }), 'svc-11');
    expect(screen.getByTestId('facet-row:service.name:svc-11')).toBeTruthy();
    // attribute keys with no matching value drop out of "N of M"
    expect(screen.getByText('0 of 0 shown')).toBeTruthy();
  });

  test('an attribute literally named resource:foo filters span.attributes, not a resource attribute', async () => {
    const user = userEvent.setup();
    const f = new FacetCounts(100, 50, ['service.name']);
    f.add('resource:foo', 'v');
    const calls: unknown[] = [];
    const store = createSelectionStore({});
    render(
      <SelectionProvider store={store}>
        <FacetPanel
          signal="span"
          facets={f}
          onToggle={(facet, value, action) => calls.push([facet, value, action])}
        />
      </SelectionProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Only v' }));
    expect(store.getState().condition).toBe('span.attributes["resource:foo"] == "v"');
    expect(calls).toEqual([[{ key: 'resource:foo', scope: 'attribute' }, 'v', 'only']]);
  });

  test('a numeric attribute is filtered with an int literal', async () => {
    const user = userEvent.setup();
    const f = new FacetCounts(100, 50, ['service.name']);
    f.add('http.status_code', '200', 'int');
    const store = createSelectionStore({});
    render(
      <SelectionProvider store={store}>
        <FacetPanel signal="span" facets={f} />
      </SelectionProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Only 200' }));
    expect(store.getState().condition).toBe('span.attributes["http.status_code"] == 200');
  });

  test('a key holding more than one value type has disabled only/exclude with a reason', () => {
    const f = new FacetCounts(100, 50, ['service.name']);
    f.add('code', '200', 'int');
    f.add('code', 'x', 'string');
    const store = createSelectionStore({});
    render(
      <SelectionProvider store={store}>
        <FacetPanel signal="span" facets={f} />
      </SelectionProvider>,
    );
    const only = screen.getByRole('button', { name: 'Only 200' }) as HTMLButtonElement;
    expect(only.disabled).toBe(true);
    expect(only.title).toMatch(/more than one type/);
  });

  test('an unexpected error from the store is rethrown, not shown as a raw-OTTL message', async () => {
    const user = userEvent.setup();
    const store = createSelectionStore({});
    store.setState({
      toggleFacet: () => {
        throw new TypeError('boom');
      },
    });
    render(
      <SelectionProvider store={store}>
        <FacetPanel signal="span" facets={facets()} />
      </SelectionProvider>,
    );
    const seen: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      e.preventDefault();
      seen.push(e.error);
    };
    window.addEventListener('error', onError);
    await user.click(screen.getByRole('button', { name: 'Exclude cart' }));
    window.removeEventListener('error', onError);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeInstanceOf(TypeError);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('dragging the duration range writes the store once, on pointer up', () => {
    const bins = [0, 1, 2, 3].map((i) => ({ fromNs: i * 1000, toNs: (i + 1) * 1000, count: 1 }));
    const { store, container } = setup(undefined, { durationBins: bins });
    let writes = 0;
    store.subscribe(() => {
      writes++;
    });
    const bin = (i: number): Element => {
      const el = container.querySelector(`[data-bin="${i}"]`);
      if (el === null) throw new Error('no bin');
      return el;
    };
    fireEvent.pointerDown(bin(1));
    fireEvent.pointerEnter(bin(2));
    fireEvent.pointerEnter(bin(3));
    expect(writes).toBe(0);
    fireEvent.pointerUp(bin(3));
    expect(writes).toBe(1);
    expect(store.getState().condition).toBe('span.end_time_unix_nano - span.start_time_unix_nano >= 1000');
  });
});

describe('FacetPanel (logs)', () => {
  function logFacets(): FacetCounts {
    const f = new FacetCounts(100, 50, [
      'severity',
      'service.name',
      'host.name',
      'event.name',
      'trace.present',
    ]);
    for (const [k, v, n] of [
      ['severity', 'warn', 3],
      ['severity', 'error', 2],
      ['severity', 'bogus', 1],
      ['service.name', 'checkout', 4],
      ['host.name', 'h1', 1],
      ['instrumentation_scope.name', 'lib', 1],
      ['event.name', 'checkout.done', 2],
      ['trace.present', 'yes', 3],
      ['trace.present', 'no', 2],
    ] as const) {
      for (let i = 0; i < n; i++) f.add(k, v);
    }
    return f;
  }
  function setupLog(q?: string) {
    const store = createSelectionStore(q === undefined ? {} : { q });
    render(
      <SelectionProvider store={store}>
        <FacetPanel signal="log" facets={logFacets()} />
      </SelectionProvider>,
    );
    return store;
  }

  test('Only on a severity writes the range pair; And above writes one >= token', async () => {
    const user = userEvent.setup();
    const store = setupLog('resource.attributes["service.name"] == "a"');
    await user.click(screen.getByRole('button', { name: 'Only warn' }));
    expect(store.getState().condition).toBe(
      'resource.attributes["service.name"] == "a" and log.severity_number >= SEVERITY_NUMBER_WARN and log.severity_number <= SEVERITY_NUMBER_WARN4',
    );
    await user.click(screen.getByRole('button', { name: 'And above warn' }));
    expect(store.getState().condition).toBe(
      'resource.attributes["service.name"] == "a" and log.severity_number >= SEVERITY_NUMBER_WARN',
    );
  });

  test('every severity band inside the filtered range shows as included, not only an exact band', () => {
    setupLog('log.severity_number >= SEVERITY_NUMBER_WARN and log.severity_number <= SEVERITY_NUMBER_FATAL4');
    expect(screen.getByTestId('facet-row:severity:warn').getAttribute('data-state')).toBe('include');
    expect(screen.getByTestId('facet-row:severity:error').getAttribute('data-state')).toBe('include');
  });

  test('a one-sided severity filter includes the bands on that side only', () => {
    setupLog('log.severity_number >= SEVERITY_NUMBER_ERROR');
    expect(screen.getByTestId('facet-row:severity:error').getAttribute('data-state')).toBe('include');
    expect(screen.getByTestId('facet-row:severity:warn').getAttribute('data-state')).toBeNull();
  });

  test('a band only partly inside the severity range is not included', () => {
    setupLog('log.severity_number >= SEVERITY_NUMBER_WARN2');
    expect(screen.getByTestId('facet-row:severity:warn').getAttribute('data-state')).toBeNull();
    expect(screen.getByTestId('facet-row:severity:error').getAttribute('data-state')).toBe('include');
  });

  test('Exclude is disabled on severity rows with the query-bar hint', () => {
    setupLog();
    const btn = screen.getByRole('button', { name: 'Exclude warn' });
    expect(btn).toHaveProperty('disabled', true);
    expect(btn.getAttribute('title')).toBe(
      'Excluding a severity needs "or", which facets cannot write. Use the query bar.',
    );
  });

  test('log facets use log paths', async () => {
    const user = userEvent.setup();
    const store = setupLog();
    await user.click(screen.getByRole('button', { name: 'Only checkout.done' }));
    await user.click(screen.getByRole('button', { name: 'Exclude yes' }));
    expect(store.getState().condition).toBe(
      'log.event_name == "checkout.done" and log.trace_id.string == ""',
    );
  });

  test('has-trace rows show include and exclude state from the inverted path ops', async () => {
    const user = userEvent.setup();
    setupLog();
    await user.click(screen.getByRole('button', { name: 'Exclude yes' }));
    expect(screen.getByTestId('facet-row:trace.present:yes').getAttribute('data-state')).toBe('exclude');
    expect(screen.getByTestId('facet-row:trace.present:no').getAttribute('data-state')).toBe('include');
  });

  test('a severity value that is not a band is skipped', () => {
    setupLog();
    expect(screen.queryByTestId('facet-row:severity:bogus')).toBeNull();
    expect(screen.getByTestId('facet-row:severity:warn')).toBeTruthy();
  });

  test('log order and headings', () => {
    setupLog();
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(names.slice(0, 6)).toEqual(['Severity', 'Service', 'Host', 'Scope', 'Event name', 'Has trace']);
  });
});

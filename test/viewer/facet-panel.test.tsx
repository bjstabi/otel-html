import { cleanup, render, screen, within } from '@testing-library/react';
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
      <FacetPanel facets={facets()} {...props} />
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
        <FacetPanel facets={f} attributePageSize={3} />
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
});

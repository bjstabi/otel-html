import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { QueryBar } from '../../src/viewer/components/query-bar.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

function setup(initial: { q?: string; text?: string } = {}) {
  const store = createSelectionStore(initial);
  render(
    <SelectionProvider store={store}>
      <QueryBar signal="span" />
    </SelectionProvider>,
  );
  return store;
}

describe('QueryBar', () => {
  test('shows condition tokens and edits an operator and value through the store', async () => {
    const user = userEvent.setup();
    const store = setup({ q: 'span.name == "a" and span.attributes["n"] >= 5' });
    expect(screen.getByText('span.attributes["n"]')).toBeTruthy();
    const value = screen.getByRole('textbox', { name: 'Value of span.attributes["n"]' });
    await user.clear(value);
    await user.type(value, '7');
    expect(store.getState().condition).toBe('span.name == "a" and span.attributes["n"] >= 7');
    await user.click(screen.getByRole('button', { name: 'Remove span.name' }));
    expect(store.getState().condition).toBe('span.attributes["n"] >= 7');
  });

  test('adds a token from the add form', async () => {
    const user = userEvent.setup();
    const store = setup();
    await user.type(screen.getByRole('textbox', { name: 'New filter key' }), 'span.name');
    await user.selectOptions(screen.getByRole('combobox', { name: 'New filter operator' }), 'contains');
    await user.type(screen.getByRole('textbox', { name: 'New filter value' }), 'a.b');
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(store.getState().condition).toBe('IsMatch(span.name, "a\\\\.b")');
  });

  test('an invalid key is reported and the store is untouched', async () => {
    const user = userEvent.setup();
    const store = setup();
    await user.type(screen.getByRole('textbox', { name: 'New filter key' }), '== ==');
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(screen.getByRole('alert').textContent).toMatch(/key/);
    expect(store.getState().condition).toBeNull();
  });

  test('the free-text box is bound to selection text and keeps the data-oh-query focus target', async () => {
    const user = userEvent.setup();
    const store = setup();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    expect(box.hasAttribute('data-oh-query')).toBe(true);
    await user.type(box, 'boom');
    expect(store.getState().text).toBe('boom');
  });

  test('OTTL toggle shows the raw condition; invalid OTTL shows the column inline and does not update the store', async () => {
    const user = userEvent.setup();
    const store = setup({ q: 'span.name == "a"' });
    await user.click(screen.getByRole('button', { name: 'OTTL' }));
    const raw = screen.getByRole('textbox', { name: 'OTTL condition' });
    expect((raw as HTMLTextAreaElement).value).toBe('span.name == "a"');
    fireEvent.change(raw, { target: { value: 'a.bcd ==' } });
    expect(screen.getByRole('alert').textContent).toMatch(/^col 9: expected expression/);
    expect(store.getState().condition).toBe('span.name == "a"');
    fireEvent.change(raw, { target: { value: 'span.name == "b" or span.name == "c"' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(store.getState().condition).toBe('span.name == "b" or span.name == "c"');
  });

  test('a compile error that is not a parse error is also surfaced', async () => {
    const user = userEvent.setup();
    const store = setup();
    await user.click(screen.getByRole('button', { name: 'OTTL' }));
    await user.type(screen.getByRole('textbox', { name: 'OTTL condition' }), 'nope.path == 1');
    expect(screen.getByRole('alert').textContent).toMatch(/^col \d+:/);
    expect(store.getState().condition).toBeNull();
  });

  test('a non-flat condition opens raw mode with a note instead of tokens', () => {
    setup({ q: 'span.name == "a" or span.name == "b"' });
    expect(screen.getByRole('textbox', { name: 'OTTL condition' })).toBeTruthy();
    expect(screen.getByText(/can.t be shown as tokens/)).toBeTruthy();
  });

  test('+ Query is disabled with its explanation', () => {
    setup();
    const btn = screen.getByRole('button', { name: '+ Query' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.parentElement?.getAttribute('title')).toBe('second query arrives with Dashboards');
  });

  test('renders hostile token values strictly as text', () => {
    const hostile = '</script><img src=x onerror=alert(1)> ';
    const { container } = render(
      <SelectionProvider
        store={createSelectionStore({ q: `span.attributes["k"] == ${JSON.stringify(hostile)}` })}
      >
        <QueryBar signal="span" />
      </SelectionProvider>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(
      (screen.getByRole('textbox', { name: 'Value of span.attributes["k"]' }) as HTMLInputElement).value,
    ).toBe(hostile);
  });
});

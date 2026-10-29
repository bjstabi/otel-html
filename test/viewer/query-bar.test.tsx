import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { QueryBar } from '../../src/viewer/components/query-bar.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

function setup(initial: { q?: string; text?: string } = {}, signal: 'span' | 'log' = 'span') {
  const store = createSelectionStore(initial);
  render(
    <SelectionProvider store={store}>
      <QueryBar signal={signal} />
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
    await user.type(value, '7{Enter}');
    expect(store.getState().condition).toBe('span.name == "a" and span.attributes["n"] >= 7');
    await user.click(screen.getByRole('button', { name: 'Remove span.name' }));
    expect(store.getState().condition).toBe('span.attributes["n"] >= 7');
  });

  test('removing a chip works even when the remaining condition does not compile for this signal', async () => {
    const user = userEvent.setup();
    const store = setup({ q: 'span.name == "a" and span.attributes["n"] >= 5' }, 'log');
    await user.click(screen.getByRole('button', { name: 'Remove span.name' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(store.getState().condition).toBe('span.attributes["n"] >= 5');
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
    await user.type(box, 'boom{Enter}');
    expect(store.getState().text).toBe('boom');
  });

  test('OTTL toggle shows the raw condition; invalid OTTL shows the column live and never reaches the store', async () => {
    const user = userEvent.setup();
    const store = setup({ q: 'span.name == "a"' });
    await user.click(screen.getByRole('button', { name: 'OTTL' }));
    const raw = screen.getByRole('textbox', { name: 'OTTL condition' });
    expect((raw as HTMLTextAreaElement).value).toBe('span.name == "a"');
    fireEvent.change(raw, { target: { value: 'a.bcd ==' } });
    expect(screen.getByRole('alert').textContent).toMatch(/^col 9: expected expression/);
    fireEvent.blur(raw);
    expect(store.getState().condition).toBe('span.name == "a"');
    fireEvent.change(raw, { target: { value: 'span.name == "b" or span.name == "c"' } });
    expect(screen.queryByRole('alert')).toBeNull();
    // valid text is not written until it is committed
    expect(store.getState().condition).toBe('span.name == "a"');
    fireEvent.keyDown(raw, { key: 'Enter' });
    expect(store.getState().condition).toBe('span.name == "b" or span.name == "c"');
  });

  test('typing raw OTTL char by char writes the store once, on commit', async () => {
    const user = userEvent.setup();
    const store = setup();
    let writes = 0;
    store.subscribe(() => {
      writes++;
    });
    await user.click(screen.getByRole('button', { name: 'OTTL' }));
    const raw = screen.getByRole('textbox', { name: 'OTTL condition' });
    await user.type(raw, 'span.name == "ab"');
    expect(writes).toBe(0);
    await user.keyboard('{Enter}');
    expect(writes).toBe(1);
  });

  test('a raw draft is discarded when the condition changes elsewhere', async () => {
    const user = userEvent.setup();
    const store = setup({ q: 'span.name == "a" or span.name == "b"' });
    const raw = screen.getByRole('textbox', { name: 'OTTL condition' });
    fireEvent.change(raw, { target: { value: 'broken ==' } });
    act(() => store.getState().setCondition('span.name == "z" or span.name == "y"'));
    expect((screen.getByRole('textbox', { name: 'OTTL condition' }) as HTMLTextAreaElement).value).toBe(
      'span.name == "z" or span.name == "y"',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    void user;
  });

  test('token value edits commit on Enter, once', async () => {
    const user = userEvent.setup();
    const store = setup({ q: 'span.attributes["n"] >= 5' });
    let writes = 0;
    store.subscribe(() => {
      writes++;
    });
    const value = screen.getByRole('textbox', { name: 'Value of span.attributes["n"]' });
    await user.clear(value);
    await user.type(value, '12');
    expect(writes).toBe(0);
    await user.keyboard('{Enter}');
    expect(writes).toBe(1);
    expect(store.getState().condition).toBe('span.attributes["n"] >= 12');
  });

  test('switching a text token to a numeric operator shows an error instead of throwing', async () => {
    const user = userEvent.setup();
    const store = setup({ q: 'span.attributes["a"] == "abc"' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Operator of span.attributes["a"]' }), '>');
    expect(screen.getByRole('alert').textContent).toMatch(/number/);
    expect(store.getState().condition).toBe('span.attributes["a"] == "abc"');
  });

  test('a severity range chip edits as an enum name, and a typed number makes it numeric', async () => {
    const user = userEvent.setup();
    const store = createSelectionStore({ q: 'log.severity_number >= SEVERITY_NUMBER_WARN' });
    render(
      <SelectionProvider store={store}>
        <QueryBar signal="log" />
      </SelectionProvider>,
    );
    const value = screen.getByRole('textbox', { name: 'Value of log.severity_number' });
    expect((value as HTMLInputElement).value).toBe('SEVERITY_NUMBER_WARN');
    await user.clear(value);
    await user.type(value, 'SEVERITY_NUMBER_ERROR{Enter}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(store.getState().condition).toBe('log.severity_number >= SEVERITY_NUMBER_ERROR');
    await user.clear(value);
    await user.type(value, '13{Enter}');
    expect(store.getState().condition).toBe('log.severity_number >= 13');
  });

  test('a failed add keeps the typed key and value', async () => {
    const user = userEvent.setup();
    const store = setup();
    await user.type(screen.getByRole('textbox', { name: 'New filter key' }), 'span.name');
    await user.selectOptions(screen.getByRole('combobox', { name: 'New filter operator' }), '>');
    await user.type(screen.getByRole('textbox', { name: 'New filter value' }), 'abc');
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(screen.getByRole('alert').textContent).toMatch(/number/);
    expect((screen.getByRole('textbox', { name: 'New filter key' }) as HTMLInputElement).value).toBe(
      'span.name',
    );
    expect((screen.getByRole('textbox', { name: 'New filter value' }) as HTMLInputElement).value).toBe('abc');
    expect(store.getState().condition).toBeNull();
  });

  test('free text is debounced: rapid typing writes the store once', () => {
    const pending: { fn: () => void; cancelled: boolean }[] = [];
    const schedule = (fn: () => void): (() => void) => {
      const p = { fn, cancelled: false };
      pending.push(p);
      return () => {
        p.cancelled = true;
      };
    };
    const store = createSelectionStore({});
    let writes = 0;
    store.subscribe(() => {
      writes++;
    });
    render(
      <SelectionProvider store={store}>
        <QueryBar signal="span" schedule={schedule} />
      </SelectionProvider>,
    );
    const box = screen.getByRole('searchbox', { name: 'Search' });
    for (const v of ['b', 'bo', 'boo', 'boom']) fireEvent.change(box, { target: { value: v } });
    expect(writes).toBe(0);
    for (const p of pending) if (!p.cancelled) act(() => p.fn());
    expect(writes).toBe(1);
    expect(store.getState().text).toBe('boom');
  });

  test('a compile error that is not a parse error is also surfaced', async () => {
    const user = userEvent.setup();
    const store = setup();
    await user.click(screen.getByRole('button', { name: 'OTTL' }));
    await user.type(screen.getByRole('textbox', { name: 'OTTL condition' }), 'nope.path == 1{Enter}');
    expect(screen.getByRole('alert').textContent).toMatch(/^col \d+:/);
    expect(store.getState().condition).toBeNull();
  });

  test('a non-flat condition opens raw mode with a note instead of tokens', () => {
    setup({ q: 'span.name == "a" or span.name == "b"' });
    expect(screen.getByRole('textbox', { name: 'OTTL condition' })).toBeTruthy();
    expect(screen.getByText(/can.t be shown as tokens/)).toBeTruthy();
  });

  test('+ Query is inert but keyboard-focusable, and its explanation is its description', async () => {
    const user = userEvent.setup();
    const store = setup();
    const btn = screen.getByRole('button', { name: '+ Query' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    act(() => btn.focus());
    expect(document.activeElement).toBe(btn);
    expect(document.getElementById(btn.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'not available yet',
    );
    await user.click(btn);
    expect(store.getState().condition).toBeNull();
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

  test('log signal compiles in log_record context: span paths are rejected and the condition is kept', async () => {
    const user = userEvent.setup();
    const store = setup({ q: 'log.severity_number >= 9' }, 'log');
    await user.click(screen.getByRole('button', { name: 'OTTL' }));
    const area = screen.getByRole('textbox', { name: 'OTTL condition' });
    await user.clear(area);
    await user.type(area, 'span.name == "x"');
    await user.tab();
    expect(screen.getByRole('alert').textContent).toMatch(/span\.name/);
    expect(store.getState().condition).toBe('log.severity_number >= 9');
  });

  test('matches tokens show as editable chips', () => {
    setup({ q: 'IsMatch(log.body.string, "a.*")' }, 'log');
    expect(screen.getByRole('combobox', { name: 'Operator of log.body.string' })).toHaveProperty(
      'value',
      'matches',
    );
  });

  test('an invalid regex in a matches chip is rejected and not stored', async () => {
    const user = userEvent.setup();
    const store = setup({ q: 'IsMatch(log.body.string, "a.*")' }, 'log');
    const value = screen.getByRole('textbox', { name: 'Value of log.body.string' });
    await user.clear(value);
    await user.type(value, '(unclosed{Enter}');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(store.getState().condition).toBe('IsMatch(log.body.string, "a.*")');
  });

  test('adding a span path in log mode is rejected', async () => {
    const user = userEvent.setup();
    const store = setup({}, 'log');
    await user.type(screen.getByRole('textbox', { name: 'New filter key' }), 'span.name');
    await user.type(screen.getByRole('textbox', { name: 'New filter value' }), 'x');
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(screen.getByRole('alert').textContent).toMatch(/span\.name/);
    expect(store.getState().condition).toBeNull();
  });
});

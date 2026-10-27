import { act, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider, useSelection } from '../../src/viewer/state/selection-context.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Text(): React.JSX.Element {
  return <p>{useSelection((s) => s.text)}</p>;
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  override render(): ReactNode {
    return this.state.error === null ? this.props.children : this.state.error.message;
  }
}

describe('SelectionProvider', () => {
  test('re-renders on selected state changes', async () => {
    const store = createSelectionStore({ text: 'one' });
    const host = document.createElement('div');
    await act(async () => {
      createRoot(host).render(
        <SelectionProvider store={store}>
          <Text />
        </SelectionProvider>,
      );
    });
    expect(host.textContent).toBe('one');
    await act(async () => store.getState().setText('two'));
    expect(host.textContent).toBe('two');
  });

  test('useSelection outside a provider fails fast', async () => {
    const host = document.createElement('div');
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      createRoot(host, {
        onCaughtError: (e) => errors.push(e),
        onUncaughtError: (e) => errors.push(e),
      }).render(
        <Boundary>
          <Text />
        </Boundary>,
      );
    });
    expect(String(errors.length > 0 ? errors[0] : host.textContent)).toMatch(/SelectionProvider/);
    vi.restoreAllMocks();
  });
});

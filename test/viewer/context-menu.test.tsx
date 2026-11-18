import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MenuItem, menuTriggers, useContextMenu } from '../../src/viewer/components/context-menu.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let api: ReturnType<typeof useContextMenu>;
let touch: ReturnType<typeof menuTriggers>;
const ran: string[] = [];
const items: readonly MenuItem[] = [
  { label: 'First', run: () => ran.push('first') },
  { label: 'Second', code: 'x = 1', run: () => ran.push('second') },
  'separator',
  { label: 'Third', run: () => ran.push('third') },
];

function Probe(): React.JSX.Element {
  api = useContextMenu();
  touch = menuTriggers((at) => api.open(at, 'Title', items));
  return (
    <div>
      <span data-testid="target" {...touch} />
      {api.element}
    </div>
  );
}

const menu = (): HTMLElement | null => document.querySelector('[role="menu"]');

beforeEach(() => {
  ran.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const key = (k: string): void => {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};

describe('context menu', () => {
  it('focuses the first item; ArrowDown then Enter runs the second and closes', () => {
    act(() => api.open({ x: 10, y: 10 }, null, items));
    expect(document.activeElement?.textContent).toContain('First');
    key('ArrowDown');
    key('Enter');
    expect(ran).toEqual(['second']);
    expect(menu()).toBeNull();
  });

  it('closes on Escape and on an outside pointer-down', () => {
    act(() => api.open({ x: 10, y: 10 }, 'T', items));
    key('Escape');
    expect(menu()).toBeNull();
    act(() => api.open({ x: 10, y: 10 }, 'T', items));
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it('shifts left to stay inside the viewport', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 100,
      toJSON: () => ({}),
    });
    act(() => api.open({ x: window.innerWidth - 10, y: 5 }, null, items));
    const left = Number.parseFloat(menu()?.style.left ?? '');
    expect(left).toBeLessThanOrEqual(window.innerWidth - 200);
    vi.restoreAllMocks();
  });

  it('opens on a 500 ms touch press, not on 200 ms', () => {
    vi.useFakeTimers();
    const target = document.querySelector('[data-testid="target"]') as HTMLElement;
    const press = (ms: number): void => {
      act(() => {
        target.dispatchEvent(
          Object.assign(new Event('pointerdown', { bubbles: true }), {
            pointerType: 'touch',
            clientX: 5,
            clientY: 5,
          }),
        );
      });
      act(() => {
        vi.advanceTimersByTime(ms);
      });
      act(() => {
        target.dispatchEvent(new Event('pointerup', { bubbles: true }));
      });
    };
    press(200);
    expect(menu()).toBeNull();
    press(500);
    expect(menu()).not.toBeNull();
  });
});

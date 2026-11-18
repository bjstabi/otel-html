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
  vi.restoreAllMocks();
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
      document.body.dispatchEvent(
        Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'mouse' }),
      );
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

  const down = (target: HTMLElement, x = 5, y = 5): void => {
    act(() => {
      target.dispatchEvent(
        Object.assign(new Event('pointerdown', { bubbles: true }), {
          pointerType: 'touch',
          clientX: x,
          clientY: y,
        }),
      );
    });
  };
  const target = (): HTMLElement => document.querySelector('[data-testid="target"]') as HTMLElement;

  it('returns focus to the opener on Escape', () => {
    const b = document.createElement('button');
    host.append(b);
    b.focus();
    act(() => api.open({ x: 10, y: 10 }, null, items));
    expect(document.activeElement).not.toBe(b);
    key('Escape');
    expect(document.activeElement).toBe(b);
  });

  it('does not open when the finger moves 20 px before 500 ms', () => {
    vi.useFakeTimers();
    down(target());
    act(() => {
      target().dispatchEvent(
        Object.assign(new Event('pointermove', { bubbles: true }), { clientX: 25, clientY: 5 }),
      );
      vi.advanceTimersByTime(600);
    });
    expect(menu()).toBeNull();
  });

  it('a re-created triggers object still cancels on pointer-up', () => {
    vi.useFakeTimers();
    down(target());
    act(() => root.render(<Probe />));
    act(() => {
      vi.advanceTimersByTime(200);
      target().dispatchEvent(new Event('pointerup', { bubbles: true }));
      vi.advanceTimersByTime(600);
    });
    expect(menu()).toBeNull();
  });

  it('swallows the click after a long press opened the menu', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    target().addEventListener('click', onClick);
    down(target());
    act(() => {
      vi.advanceTimersByTime(500);
      target().dispatchEvent(new Event('pointerup', { bubbles: true }));
    });
    expect(menu()).not.toBeNull();
    target().dispatchEvent(new Event('click', { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('closes on Tab and Home/End move focus', () => {
    act(() => api.open({ x: 10, y: 10 }, null, items));
    key('End');
    expect(document.activeElement?.textContent).toContain('Third');
    key('Home');
    expect(document.activeElement?.textContent).toContain('First');
    key('Tab');
    expect(menu()).toBeNull();
  });

  it('a fired press ended by pointercancel does not block a later contextmenu', () => {
    vi.useFakeTimers();
    down(target());
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(menu()).not.toBeNull();
    key('Escape');
    act(() => {
      target().dispatchEvent(new Event('pointercancel', { bubbles: true }));
    });
    act(() => {
      target().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 7, clientY: 7 }));
    });
    expect(menu()).not.toBeNull();
  });
});

describe('the menu element', () => {
  const open = (): void => act(() => api.open({ x: 5, y: 5 }, 'Title', items));

  it('is a child of body, outside the page content that opened it', () => {
    open();
    expect(menu()?.parentElement).toBe(document.body);
    expect(host.contains(menu())).toBe(false);
  });

  it('has one tab stop, which follows the focus', () => {
    open();
    const tabs = (): (string | null)[] =>
      [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.getAttribute('tabindex'));
    expect(tabs()).toEqual(['0', '-1', '-1']);
    key('ArrowDown');
    expect(tabs()).toEqual(['-1', '0', '-1']);
  });

  it('closes when the window is resized', () => {
    open();
    expect(menu()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(menu()).toBeNull();
  });
});

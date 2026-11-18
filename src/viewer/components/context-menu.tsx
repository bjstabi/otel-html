import {
  type JSX,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

export type MenuItem = { label: string; code?: string; run(): void } | 'separator';

type At = { x: number; y: number };
type Open = { at: At; title: string | null; items: readonly MenuItem[] };

const MARGIN = 4;
const LONG_PRESS_MS = 500;

export function useContextMenu(): {
  open(at: At, title: string | null, items: readonly MenuItem[]): void;
  element: JSX.Element;
} {
  const [state, setState] = useState<Open | null>(null);
  const open = useCallback((at: At, title: string | null, items: readonly MenuItem[]) => {
    setState({ at, title, items });
  }, []);
  const close = useCallback(() => setState(null), []);
  return {
    open,
    element: state === null ? <></> : <Menu key={`${state.at.x},${state.at.y}`} {...state} onClose={close} />,
  };
}

function Menu(props: Open & { onClose(): void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<At>(props.at);
  const { onClose } = props;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(MARGIN, Math.min(props.at.x, window.innerWidth - r.width - MARGIN)),
      y: Math.max(MARGIN, Math.min(props.at.y, window.innerHeight - r.height - MARGIN)),
    });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [props.at.x, props.at.y]);

  useEffect(() => {
    const outside = (e: Event): void => {
      if (!(e.target instanceof Node) || ref.current?.contains(e.target) !== true) onClose();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      buttons[at]?.click();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={props.title ?? 'Actions'}
      onKeyDown={onKeyDown}
      style={{ position: 'fixed', left: pos.x, top: pos.y }}
      className="z-50 min-w-48 max-w-80 rounded-card border border-hairline bg-surface py-1 text-sm text-ink shadow-lg"
    >
      {props.title !== null && <div className="truncate px-3 py-1 text-xs text-muted">{props.title}</div>}
      {[...props.items.entries()].map(([id, item]) =>
        item === 'separator' ? (
          <hr key={id} className="my-1 border-hairline" />
        ) : (
          <button
            key={id}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              item.run();
            }}
            className="block w-full px-3 py-1 text-left hover:bg-hairline focus:bg-hairline focus:outline-none"
          >
            <span>{item.label}</span>
            {item.code !== undefined && (
              <code className="ml-2 font-mono text-xs text-muted">{item.code}</code>
            )}
          </button>
        ),
      )}
    </div>
  );
}

export function menuTriggers(open: (at: At) => void): {
  onContextMenu(e: MouseEvent): void;
  onPointerDown(e: PointerEvent): void;
  onPointerUp(): void;
  onPointerCancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    onContextMenu: (e) => {
      e.preventDefault();
      open({ x: e.clientX, y: e.clientY });
    },
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch') return;
      const at = { x: e.clientX, y: e.clientY };
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        open(at);
      }, LONG_PRESS_MS);
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };
}

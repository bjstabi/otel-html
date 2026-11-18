import {
  type CSSProperties,
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
  element: JSX.Element | null;
} {
  const [state, setState] = useState<Open | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback((at: At, title: string | null, items: readonly MenuItem[]) => {
    if (opener.current === null && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement;
    setState({ at, title, items });
  }, []);
  const close = useCallback(() => {
    setState(null);
    opener.current?.focus();
    opener.current = null;
  }, []);
  return {
    open,
    element: state === null ? null : <Menu key={`${state.at.x},${state.at.y}`} {...state} onClose={close} />,
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
    } else if (e.key === 'Tab') {
      onClose();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      buttons[e.key === 'Home' ? 0 : buttons.length - 1]?.focus();
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

type Press = { timer: ReturnType<typeof setTimeout> | undefined; x: number; y: number; fired: boolean };
const presses = new WeakMap<EventTarget, Press>();
const MOVE_SLOP = 10;
const SUPPRESS_MS = 600;

function cancelPress(target: EventTarget): void {
  const p = presses.get(target);
  if (p === undefined) return;
  if (p.timer !== undefined) clearTimeout(p.timer);
  p.timer = undefined;
  if (!p.fired) presses.delete(target);
}

// No click follows a cancel or a leave, so a fired press is forgotten at once.
function endPress(target: EventTarget): void {
  cancelPress(target);
  presses.delete(target);
}

// After a long press opened the menu, the lift is followed by a click (and maybe a contextmenu) on
// the target; swallow the click once and keep the `fired` mark until it is past.
function suppressFollowUp(target: EventTarget): void {
  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => {
    document.removeEventListener('click', swallow, { capture: true });
    presses.delete(target);
  }, SUPPRESS_MS);
}

export function menuTriggers(open: (at: At) => void): {
  onContextMenu(e: MouseEvent): void;
  onPointerDown(e: PointerEvent): void;
  onPointerMove(e: PointerEvent): void;
  onPointerUp(e: PointerEvent): void;
  onPointerLeave(e: PointerEvent): void;
  onPointerCancel(e: PointerEvent): void;
  style: CSSProperties;
} {
  return {
    style: { WebkitTouchCallout: 'none' },
    onContextMenu: (e) => {
      e.preventDefault();
      if (presses.get(e.currentTarget)?.fired === true) return;
      open({ x: e.clientX, y: e.clientY });
    },
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch') return;
      const target = e.currentTarget;
      cancelPress(target);
      const press: Press = { timer: undefined, x: e.clientX, y: e.clientY, fired: false };
      press.timer = setTimeout(() => {
        press.timer = undefined;
        press.fired = true;
        open({ x: press.x, y: press.y });
      }, LONG_PRESS_MS);
      presses.set(target, press);
    },
    onPointerMove: (e) => {
      const p = presses.get(e.currentTarget);
      if (p === undefined || p.fired) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_SLOP) cancelPress(e.currentTarget);
    },
    onPointerUp: (e) => {
      const target = e.currentTarget;
      const fired = presses.get(target)?.fired === true;
      cancelPress(target);
      if (fired) suppressFollowUp(target);
    },
    onPointerLeave: (e) => endPress(e.currentTarget),
    onPointerCancel: (e) => endPress(e.currentTarget),
  };
}

import { describe, expect, test, vi } from 'vitest';
import {
  createShortcutHandler,
  SHORTCUTS,
  type ShortcutAction,
  type ShortcutActions,
} from '../../src/viewer/shell/shortcuts.js';

function actionsSpy(): { actions: ShortcutActions; calls: ShortcutAction[] } {
  const calls: ShortcutAction[] = [];
  const mk =
    (a: ShortcutAction): (() => void) =>
    () => {
      calls.push(a);
    };
  const actions: ShortcutActions = {
    goDashboards: mk('goDashboards'),
    goLogs: mk('goLogs'),
    goMetrics: mk('goMetrics'),
    goTraces: mk('goTraces'),
    next: mk('next'),
    previous: mk('previous'),
    clear: mk('clear'),
    focusQuery: mk('focusQuery'),
    help: mk('help'),
  };
  return { actions, calls };
}

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('SHORTCUTS', () => {
  test('lists exactly the documented keys', () => {
    expect(SHORTCUTS.map((s) => s.keys.join(' '))).toEqual([
      'g d',
      'g l',
      'g m',
      'g t',
      'j',
      'k',
      'Esc',
      '/',
      '?',
    ]);
  });
});

describe('createShortcutHandler', () => {
  test('runs two-key sequences and single keys', () => {
    const { actions, calls } = actionsSpy();
    const h = createShortcutHandler(SHORTCUTS, actions);
    h(key(document.body, 'g'));
    h(key(document.body, 'l'));
    h(key(document.body, 'j'));
    h(key(document.body, 'Escape'));
    expect(calls).toEqual(['goLogs', 'next', 'clear']);
  });

  test('ignores keystrokes inside input, textarea, select and contenteditable', () => {
    const { actions, calls } = actionsSpy();
    const h = createShortcutHandler(SHORTCUTS, actions);
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.append(inner);
    for (const t of [input, area, select, inner]) {
      h(key(t, 'g'));
      h(key(t, 'l'));
      h(key(t, 'j'));
    }
    expect(calls).toEqual([]);
  });

  test('a sequence is dropped after the timeout and by an unrelated key', () => {
    const { actions, calls } = actionsSpy();
    let now = 0;
    const h = createShortcutHandler(SHORTCUTS, actions, () => now);
    h(key(document.body, 'g'));
    now = 5000;
    h(key(document.body, 'l'));
    h(key(document.body, 'g'));
    h(key(document.body, 'x'));
    h(key(document.body, 'l'));
    expect(calls).toEqual([]);
  });

  test('the timeout is measured between the key events, not between handling them', () => {
    const { actions, calls } = actionsSpy();
    const h = createShortcutHandler(SHORTCUTS, actions);
    const at = (k: string, timeStamp: number): KeyboardEvent => {
      const e = key(document.body, k);
      Object.defineProperty(e, 'timeStamp', { value: timeStamp });
      return e;
    };
    // Handled back to back here, as a page busy for seconds would handle them, but pressed 400 ms apart.
    h(at('g', 100));
    h(at('l', 500));
    expect(calls).toEqual(['goLogs']);
    h(at('g', 1000));
    h(at('l', 2100));
    expect(calls).toEqual(['goLogs']);
  });

  test('ignores chords with ctrl, meta or alt and prevents default for handled keys', () => {
    const { actions, calls } = actionsSpy();
    const h = createShortcutHandler(SHORTCUTS, actions);
    h(key(document.body, 'j', { ctrlKey: true }));
    expect(calls).toEqual([]);
    const e = key(document.body, '/');
    const spy = vi.spyOn(e, 'preventDefault');
    h(e);
    expect(calls).toEqual(['focusQuery']);
    expect(spy).toHaveBeenCalled();
  });

  test('ignores prevented and composing events and anything while a dialog or menu is open', () => {
    const { actions, calls } = actionsSpy();
    const h = createShortcutHandler(SHORTCUTS, actions);
    const prevented = key(document.body, 'j');
    prevented.preventDefault();
    h(prevented);
    h(key(document.body, 'j', { isComposing: true }));
    expect(calls).toEqual([]);
    for (const role of ['dialog', 'menu']) {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', role);
      document.body.append(overlay);
      h(key(document.body, 'j'));
      h(key(overlay, 'Escape'));
      overlay.remove();
    }
    expect(calls).toEqual([]);
    h(key(document.body, 'j'));
    expect(calls).toEqual(['next']);
  });
});

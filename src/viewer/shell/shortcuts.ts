export type ShortcutAction =
  | 'goDashboards'
  | 'goLogs'
  | 'goMetrics'
  | 'goTraces'
  | 'next'
  | 'previous'
  | 'clear'
  | 'focusQuery'
  | 'help';

export interface Shortcut {
  /** One key, or a sequence pressed one after the other (`g` then `l`). `Esc` is the Escape key. */
  readonly keys: readonly string[];
  readonly action: ShortcutAction;
  readonly label: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['g', 'd'], action: 'goDashboards', label: 'Go to Dashboards' },
  { keys: ['g', 'l'], action: 'goLogs', label: 'Go to Logs' },
  { keys: ['g', 'm'], action: 'goMetrics', label: 'Go to Metrics' },
  { keys: ['g', 't'], action: 'goTraces', label: 'Go to Traces' },
  { keys: ['j'], action: 'next', label: 'Next row' },
  { keys: ['k'], action: 'previous', label: 'Previous row' },
  { keys: ['Esc'], action: 'clear', label: 'Close the open log, trace or span' },
  { keys: ['/'], action: 'focusQuery', label: 'Focus the query bar' },
  { keys: ['?'], action: 'help', label: 'Show keyboard shortcuts' },
];

export type ShortcutActions = Record<ShortcutAction, () => void>;

/** A second key must follow the first within this time. */
export const SEQUENCE_TIMEOUT_MS = 1000;

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** An open dialog or menu owns the keyboard (its own Escape, arrows and typing), so shortcuts stay out. */
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]';

function overlayOpen(): boolean {
  return document.querySelector(OVERLAY) !== null;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE) !== null;
}

function keyName(e: KeyboardEvent): string {
  return e.key === 'Escape' ? 'Esc' : e.key;
}

/**
 * Keystrokes in form fields never trigger shortcuts. A pending sequence expires on a timer rather than by comparing the
 * keys' times: a page busy drawing (a dashboard on a slow machine) handles keys pressed milliseconds apart a second or
 * more apart, and stamps them with that handling time, but the second key is already queued ahead of the timer.
 */
export function createShortcutHandler(
  table: readonly Shortcut[],
  actions: ShortcutActions,
): (e: KeyboardEvent) => void {
  let pending: string[] = [];
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const setPending = (seq: string[]): void => {
    clearTimeout(expiry);
    pending = seq;
    expiry =
      seq.length === 0
        ? undefined
        : setTimeout(() => {
            pending = [];
          }, SEQUENCE_TIMEOUT_MS);
  };

  const startsWith = (seq: readonly string[]): boolean =>
    table.some((s) => s.keys.length > seq.length && seq.every((k, i) => s.keys[i] === k));
  const exact = (seq: readonly string[]): Shortcut | undefined =>
    table.find((s) => s.keys.length === seq.length && s.keys.every((k, i) => seq[i] === k));

  return (e) => {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target) || overlayOpen()) return;
    const k = keyName(e);
    let seq = [...pending, k];
    if (exact(seq) === undefined && !startsWith(seq)) seq = [k];
    const hit = exact(seq);
    if (hit !== undefined) {
      setPending([]);
      e.preventDefault();
      actions[hit.action]();
    } else if (startsWith(seq)) {
      setPending(seq);
    } else {
      setPending([]);
    }
  };
}

import { useEffect, useRef } from 'react';
import type { WidgetActions } from '../dashboard-page.js';
import type { WidgetScope } from '../scope.js';

/** Shows `text` as the widget frame's subtitle while mounted; null (or unmounting) restores the frame's own. */
export function useSubtitle(actions: WidgetActions, text: string | null): void {
  // The page builds new actions on every render; only a change of text should reach the frame.
  const set = useRef(actions.setSubtitle);
  set.current = actions.setSubtitle;
  useEffect(() => {
    set.current(text);
    return () => set.current(null);
  }, [text]);
}

/** `1 trace`, `2 traces`. */
export function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** A record widget's subtitle: the count, then what narrows it (`3 logs for the selected trace`, `1 span in selected time`). */
export function scopedCount(
  n: number,
  noun: string,
  scope: Pick<WidgetScope, 'narrowed' | 'traceFilter'>,
): string {
  if (scope.traceFilter !== null) return `${count(n, noun)} for the selected trace`;
  return scope.narrowed ? `${count(n, noun)} in selected time` : count(n, noun);
}

import { type JSX, type KeyboardEvent, useCallback, useState } from 'react';
import { formatDuration } from '../../../semconv/formatters.js';
import type { RunActions } from '../run-actions.js';
import type { CiRun } from '../runs.js';

/**
 * Keyboard and screen-reader access to the runs a canvas chart draws (the marks themselves are not focusable).
 * The chart's container is one focusable element: Left/Right (Home/End) move a current-run highlight, Enter or Space
 * opens the run, ContextMenu or Shift+F10 its menu at the mark. `plot` is the chart's horizontal padding in px, to
 * place the menu on the mark.
 */
export function useRunKeys(
  runs: readonly CiRun[],
  actions: Pick<RunActions, 'openRun' | 'runMenu'>,
  plot: { left: number; right: number },
): {
  /** The index of the highlighted run while the container has focus; null otherwise. */
  current: number | null;
  /** Spread on the container. */
  props: {
    tabIndex: 0;
    onKeyDown(e: KeyboardEvent<HTMLElement>): void;
    onFocus(): void;
    onBlur(): void;
  };
  /** The polite live region naming the current run; render it inside the container. */
  live: JSX.Element;
} {
  const { openRun, runMenu } = actions;
  const [index, setIndex] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const at = index === null ? null : Math.min(index, runs.length - 1);
  const run = at === null ? undefined : runs[at];

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>): void => {
      if (runs.length === 0) return;
      const last = runs.length - 1;
      const from = at ?? -1;
      const go = (i: number): void => {
        e.preventDefault();
        setIndex(Math.max(0, Math.min(last, i)));
      };
      const box = e.currentTarget.getBoundingClientRect();
      if (e.key === 'ArrowRight') go(at === null ? 0 : from + 1);
      else if (e.key === 'ArrowLeft') go(at === null ? last : from - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(last);
      else if (run !== undefined && at !== null && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openRun(run, { x: markX(box, plot, at, runs.length), y: box.top + box.height / 2 });
      } else if (
        run !== undefined &&
        at !== null &&
        (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))
      ) {
        e.preventDefault();
        runMenu(run, { x: markX(box, plot, at, runs.length), y: box.top + box.height / 2 });
      }
    },
    [runs, at, run, openRun, runMenu, plot],
  );

  return {
    current: focused ? at : null,
    props: {
      tabIndex: 0,
      onKeyDown,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    },
    live: (
      <span aria-live="polite" className="sr-only">
        {run === undefined
          ? ''
          : `${run.title ?? `Run ${run.runId}`} · ${run.result} · ${formatDuration(run.duration)}`}
      </span>
    ),
  };
}

/** The x of the `i`th of `n` evenly spaced marks inside the box minus the plot padding. */
function markX(box: DOMRect, plot: { left: number; right: number }, i: number, n: number): number {
  return box.left + plot.left + ((i + 0.5) / n) * Math.max(0, box.width - plot.left - plot.right);
}

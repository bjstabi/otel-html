import type { JSX } from 'react';

/** A `mode` or `view` in the URL that this page does not offer: say so (never reinterpret it) and offer a reset. */
export function PageOptionNotice(props: { message: string | null; onReset: () => void }): JSX.Element | null {
  if (props.message === null) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-card border border-hairline bg-surface px-4 py-2 text-sm"
    >
      <p className="flex-1 font-mono text-xs text-ink-2">{props.message}</p>
      <button
        type="button"
        onClick={props.onReset}
        className="rounded-full px-3 py-1 text-sm hover:bg-hairline"
      >
        Reset
      </button>
    </div>
  );
}

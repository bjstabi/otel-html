import type { JSX } from 'react';
import { FIELD } from './field.js';

export function ColumnPicker(props: {
  keys: readonly string[];
  chosen: readonly string[];
  onChange(chosen: readonly string[]): void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2 text-ink-2">
        Columns
        <select
          className={FIELD}
          value=""
          aria-label="Add column"
          onChange={(e) => e.target.value !== '' && props.onChange([...props.chosen, e.target.value])}
        >
          <option value="">Add attribute column</option>
          {props.keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      {props.chosen.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => props.onChange(props.chosen.filter((c) => c !== k))}
          aria-label={`Remove column ${k}`}
          className="rounded-full border border-hairline px-2 py-0.5 font-mono text-xs hover:bg-hairline"
        >
          {k} <span aria-hidden>×</span>
        </button>
      ))}
    </div>
  );
}

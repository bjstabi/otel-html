import type { JSX } from 'react';
import { type LogSeverityKey, severityKey } from '../../semconv/severity.js';

/** The band's name and its colour token; the colour only repeats what the label says. */
export function SeverityLabel(props: { band: LogSeverityKey }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ background: `var(--oh-sev-${props.band})` }}
      />
      <span>{props.band.toUpperCase()}</span>
    </span>
  );
}

/** `ERROR · 17`, plus the record's own severity text when it says something other than the band. */
export function SeverityBadge(props: { number: number; text: string }): JSX.Element {
  const band = severityKey(props.number);
  const showText = props.text !== '' && props.text.toLowerCase() !== band;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ background: `var(--oh-sev-${band})` }}
      />
      <span className="font-mono text-xs">{`${band.toUpperCase()} · ${props.number}`}</span>
      {showText ? <span className="truncate text-xs text-muted">{props.text}</span> : null}
    </span>
  );
}

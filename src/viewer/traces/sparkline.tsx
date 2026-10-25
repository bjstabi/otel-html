import type { JSX } from 'react';

/** A tiny line of `values`; decorative, the numbers it summarises are always shown next to it. */
export function Sparkline(props: {
  values: readonly number[];
  width?: number;
  height?: number;
}): JSX.Element {
  const width = props.width ?? 80;
  const height = props.height ?? 20;
  const max = Math.max(1, ...props.values);
  const step = props.values.length > 1 ? width / (props.values.length - 1) : 0;
  const points = props.values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg aria-hidden width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="text-accent">
      {props.values.length > 1 ? (
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} />
      ) : (
        <circle cx={width / 2} cy={height / 2} r={2} fill="currentColor" />
      )}
    </svg>
  );
}

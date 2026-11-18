const MINUTE_NS = 60_000_000_000;
const HOUR_NS = 60 * MINUTE_NS;
const DAY_NS = 24 * HOUR_NS;
/** An edge this close (as a share of the extent) counts as the extent's own edge. */
export const EDGE_SNAP = 0.005;

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** A duration for people: whole minutes under an hour, whole hours under 48 h, else days (one decimal unless whole). */
export function humanDur(ns: number): string {
  if (ns < HOUR_NS) return plural(Math.round(ns / MINUTE_NS), 'minute');
  if (ns < 48 * HOUR_NS) return plural(Math.round(ns / HOUR_NS), 'hour');
  const days = Math.round((ns / DAY_NS) * 10) / 10;
  return plural(days, 'day');
}

/** A preset text (`7d`, `90m`, `all`) as words; null for anything else. */
function presetLabel(preset: string | null): string | null {
  if (preset === 'all') return 'entire run';
  const m = /^([1-9][0-9]*)(m|h|d)$/.exec(preset ?? '');
  if (m === null) return null;
  const unit = m[2] === 'm' ? MINUTE_NS : m[2] === 'h' ? HOUR_NS : DAY_NS;
  return `last ${humanDur(Number(m[1]) * unit)}`;
}

export function stamp(rel: number, epoch: bigint): string {
  const ms = Number((BigInt(Math.round(rel)) + epoch) / 1_000_000n);
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export interface RangeLabel {
  label: string;
  /** ` of <extent duration>` when zoomed, else null. */
  of: string | null;
  zoomed: boolean;
  /** `<from> – <to> · <duration>` when zoomed, else an empty string. */
  header: string;
}

/**
 * The words for the slider: the preset while there is no zoom; `last <duration>` for a zoom that reaches the extent's
 * end (within 0.5 %); `custom` for any other. `epoch` turns run-relative times into the dates in `header`.
 */
export function rangeLabel(o: {
  preset: string | null;
  extent: [number, number];
  zoom: [number, number] | null;
  epoch?: bigint;
}): RangeLabel {
  const [e0, e1] = o.extent;
  if (o.zoom === null)
    return { label: presetLabel(o.preset) ?? 'custom', of: null, zoomed: false, header: '' };
  const [z0, z1] = o.zoom;
  const atEnd = Math.abs(e1 - z1) <= (e1 - e0) * EDGE_SNAP;
  const width = z1 - z0;
  const epoch = o.epoch ?? 0n;
  return {
    label: atEnd ? `last ${humanDur(width)}` : 'custom',
    of: ` of ${humanDur(e1 - e0)}`,
    zoomed: true,
    header: `${stamp(z0, epoch)} – ${stamp(z1, epoch)} · ${humanDur(width)}`,
  };
}

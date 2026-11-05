/** Categorical colours in fixed order; validated with the dataviz validate_palette.js (see commit). */
export const CATEGORICAL_LIGHT: readonly string[] = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
];

export const CATEGORICAL_DARK: readonly string[] = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
];

/** A set of series colours: the fixed ones first, per mode, then as many more as are asked for. */
export interface Palette {
  light: readonly string[];
  dark: readonly string[];
}

const DEFAULT_PALETTE: Palette = { light: CATEGORICAL_LIGHT, dark: CATEGORICAL_DARK };

export const STATUS = { critical: '#d03b3b', warning: '#fab219' } as const;

/**
 * Log severity colours per mode (mirrored by the `--oh-sev-*` tokens in tokens.css; a test keeps them in sync).
 * `unspecified` is the muted ink token in both modes, so it is not listed.
 */
export const SEVERITY_LIGHT = {
  fatal: '#8f1d21',
  error: '#d03b3b',
  warn: '#b87a00',
  info: '#2a78d6',
  debug: '#7a818c',
  trace: '#898e98',
} as const;

export const SEVERITY_DARK = {
  fatal: '#f0709a',
  error: '#e5605f',
  warn: '#fab219',
  info: '#3987e5',
  debug: '#9ca3af',
  trace: '#6f7681',
} as const;

function hueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const huesByPalette = new WeakMap<Palette, number[]>();

/** The hue of a colour past the fixed ones: the middle of the widest gap left on the wheel, so gaps only ever narrow. */
function hueAt(palette: Palette, index: number): number {
  const hues = huesByPalette.get(palette) ?? palette.light.map(hueOf);
  huesByPalette.set(palette, hues);
  while (hues.length <= index) {
    const sorted = [...hues].sort((a, b) => a - b);
    let from = 0;
    let widest = -1;
    for (const [i, h] of sorted.entries()) {
      const gap = (sorted[i + 1] ?? (sorted[0] ?? 0) + 360) - h;
      if (gap > widest) {
        widest = gap;
        from = h;
      }
    }
    hues.push((from + widest / 2) % 360);
  }
  return hues[index] as number;
}

/** A colour past the fixed ones. Lightness is a theme token, and alternates to tell apart hues that have grown close. */
function generatedColor(palette: Palette, index: number): string {
  const lightness = index % 2 === 0 ? '--oh-series-lightness' : '--oh-series-lightness-alt';
  return `hsl(${hueAt(palette, index).toFixed(1)}, 68%, var(${lightness}))`;
}

/** The custom property of a series colour. Past the palette it exists once `colorFor` has handed out that index. */
export const seriesToken = (index: number): string => `--oh-series-${index + 1}`;

export const seriesVar = (index: number): string => `var(${seriesToken(index)})`;

export interface ColorAssigner {
  /** 0, 1, 2... by first-seen order, without end. Stable once assigned. */
  colorFor(entity: string): number;
}

// This module also loads outside a browser, where no document has tokens to set.
const rootStyle = (): { setProperty(name: string, value: string): void } | undefined =>
  (globalThis as { document?: { documentElement: { style: { setProperty(n: string, v: string): void } } } })
    .document?.documentElement.style;

export function createColorAssigner(palette: Palette = DEFAULT_PALETTE): ColorAssigner {
  const seen = new Map<string, number>();
  return {
    colorFor(entity: string): number {
      const existing = seen.get(entity);
      if (existing !== undefined) return existing;
      const index = seen.size;
      seen.set(entity, index);
      if (index >= palette.light.length)
        rootStyle()?.setProperty(seriesToken(index), generatedColor(palette, index));
      return index;
    },
  };
}

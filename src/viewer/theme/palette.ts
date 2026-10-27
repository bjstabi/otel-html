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
  trace: '#8d929b',
} as const;

export const SEVERITY_DARK = {
  fatal: '#f0709a',
  error: '#e5605f',
  warn: '#fab219',
  info: '#3987e5',
  debug: '#9ca3af',
  trace: '#6f7681',
} as const;

/** Index used for every entity past the seventh: the neutral "Other" gray. */
export const OTHER_INDEX = 7;

export interface ColorAssigner {
  /** 0..6 by first-seen order; 7 (Other) for the 8th entity onwards. Stable once assigned. */
  colorFor(entity: string): number;
}

export function createColorAssigner(): ColorAssigner {
  const seen = new Map<string, number>();
  return {
    colorFor(entity: string): number {
      const existing = seen.get(entity);
      if (existing !== undefined) return existing;
      const index = Math.min(seen.size, OTHER_INDEX);
      seen.set(entity, index);
      return index;
    },
  };
}

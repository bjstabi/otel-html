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

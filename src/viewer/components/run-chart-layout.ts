/** A small chart's plot must be at least this tall, or the split falls back to one plot. */
export const SPLIT_MIN_PLOT_PX = 60;

const MIN_CELL_PX = 230;
const TOP_PX = 8;
const TITLE_PX = 18;
const ROW_GAP_PX = 8;
const X_LABEL_PX = 32;
const SLIDER_PX = 40;
const LEFT_PX = 56;
const RIGHT_PX = 16;

export interface PlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Whether this plot shows x labels: the only plot, or the bottom row of a split. */
  xLabels: boolean;
}

/**
 * Pixel rectangles for the plots of one chart. `forceSplit` keeps the split when it would be too small,
 * for mixed units, where each unit needs its own plot.
 */
export function plotRects(i: {
  width: number;
  height: number;
  plots: number;
  split: boolean;
  slider: boolean;
  forceSplit?: boolean;
}): { rects: PlotRect[]; splitFits: boolean } {
  const usable = i.height - (i.slider ? SLIDER_PX : 0);
  const single = (): PlotRect[] => [
    {
      left: LEFT_PX,
      top: TOP_PX,
      width: Math.max(0, i.width - LEFT_PX - RIGHT_PX),
      height: Math.max(0, usable - TOP_PX - X_LABEL_PX),
      xLabels: true,
    },
  ];
  if (!i.split || i.plots <= 1) return { rects: single(), splitFits: true };

  const cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(i.plots)), Math.floor(i.width / MIN_CELL_PX)));
  const rows = Math.ceil(i.plots / cols);
  const plotH = Math.max(0, (usable - TOP_PX - X_LABEL_PX - rows * (TITLE_PX + ROW_GAP_PX)) / rows);
  if (plotH < SPLIT_MIN_PLOT_PX && !i.forceSplit) return { rects: single(), splitFits: false };

  const rects: PlotRect[] = [];
  for (let n = 0; n < i.plots; n++) {
    const row = Math.floor(n / cols);
    const inRow = row === rows - 1 ? i.plots - row * cols : cols;
    const cellW = i.width / inRow;
    rects.push({
      left: (n % cols) * cellW + LEFT_PX,
      top: TOP_PX + row * (plotH + TITLE_PX + ROW_GAP_PX) + TITLE_PX,
      width: Math.max(0, cellW - LEFT_PX - RIGHT_PX),
      height: plotH,
      xLabels: row === rows - 1,
    });
  }
  return { rects, splitFits: true };
}

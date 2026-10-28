import { describe, expect, test, vi } from 'vitest';
import { detailOf, spanIdOf, traceRow } from './trace-rows.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));

import {
  type FlameTheme,
  flameOption,
  labelWidth,
  OUTLINE_TAIL,
} from '../../src/viewer/components/flame-graph.js';
import { layoutFlame } from '../../src/viewer/components/flame-layout.js';

// Its own file: the flame graph caches its measuring canvas per module, and the other flame tests have no canvas.
const fonts: string[] = [];
const ctx = {
  font: '',
  // A narrow font: one pixel per character, far below the 6.6 px per character heuristic.
  measureText(text: string) {
    fonts.push(this.font);
    return { width: text.length };
  },
};
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
  ctx as unknown as CanvasRenderingContext2D,
);

const THEME: FlameTheme = {
  ink: '#16181d',
  surface: '#ffffff',
  critical: '#d03b3b',
  muted: '#6b6f78',
  hairline: '#e4e4de',
  accent: '#0f766e',
  font: 'monospace',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#9a9da5'],
};

interface Shape {
  type: string;
  style?: { text?: unknown };
}

describe('flame label width', () => {
  test('labelWidth measures the text in the given font on a canvas', () => {
    fonts.length = 0;
    expect(labelWidth('abcd', '11px monospace')).toBe(4);
    expect(fonts).toEqual(['11px monospace']);
  });

  test('the outlined bar gets its tail when the measured label fits, even where the heuristic says it would not', () => {
    const { tree } = detailOf([
      traceRow(1, null, 0, 1000, { service: 'web', name: 'root' }),
      traceRow(2, 1, 100, 400, { service: 'db', name: 'q' }),
    ]);
    const { bars } = layoutFlame(tree, { colorBy: 'service', filter: '', errorsOnly: false });
    const o = flameOption(bars, THEME, {
      selectedSpanId: null,
      zoom: { start: 0, end: 100 },
      maxRows: 200,
      outlineSpanId: spanIdOf(2),
    });
    const s = Array.isArray(o.series) ? o.series[0] : o.series;
    const renderItem = (s as { renderItem: (p: unknown, a: unknown) => { children: Shape[] } }).renderItem;
    // Bar 1 is 60 px wide: (label + tail) × 6.6 px would not fit in its 52 px of text room, but 1 px a character does.
    const api = {
      value: (d: number) => [bars[1]?.depth ?? 0, bars[1]?.start ?? 0, bars[1]?.end ?? 0, 1][d],
      coord: ([x, y]: [number, number]) => [x / 5, y * 18],
    };
    const text = renderItem({ coordSys: { x: 0, y: 0, width: 200, height: 100 } }, api).children.find(
      (c) => c.type === 'text',
    )?.style?.text;
    expect(String(text)).toContain(OUTLINE_TAIL);
    expect(fonts.at(-1)).toBe('11px monospace');
  });
});

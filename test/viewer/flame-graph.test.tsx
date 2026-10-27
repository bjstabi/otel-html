import { describe, expect, test, vi } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { detailOf, traceRow } from './trace-rows.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));

import {
  barAt,
  buildFlameItems,
  type FlameTheme,
  flameOption,
  labelColorOn,
  minimapOption,
  sampleForOverview,
} from '../../src/viewer/components/flame-graph.js';
import { layoutFlame } from '../../src/viewer/components/flame-layout.js';
import { spanIdOf } from './trace-rows.js';

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
const HOSTILE = '</script><img src=x onerror=alert(1)> ';

interface Shape {
  type: string;
  style?: { text?: unknown; stroke?: unknown };
}

vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); // jsdom has no canvas: no hatch pattern

describe('flameOption', () => {
  const { tree } = detailOf([
    traceRow(1, null, 0, 1000, { service: 'web', name: HOSTILE }),
    traceRow(2, 1, 100, 400, { service: 'db', error: true }),
  ]);
  const { bars } = layoutFlame(tree, { colorBy: 'service', filter: '', errorsOnly: false });
  const view = { selectedSpanId: spanIdOf(2), zoom: { start: 0, end: 100 }, maxRows: 200 };
  const option = flameOption(bars, THEME, view);
  const series = Array.isArray(option.series) ? option.series[0] : option.series;

  test('is one custom series with a row per bar and no HTML tooltip', () => {
    expect(series?.type).toBe('custom');
    expect((series as { data: unknown[] }).data).toEqual([
      [0, 0, 1000, 0],
      [1, 100, 400, 1],
    ]);
    expect(option.tooltip).toEqual({ show: false });
  });

  test('bars draw with canvas text: the hostile name is a plain string, error bars get an outline, the selection a ring', () => {
    const renderItem = (series as { renderItem: (p: unknown, a: unknown) => { children: Shape[] } })
      .renderItem;
    const api = (i: number) => ({
      value: (d: number) => [bars[i]?.depth ?? 0, bars[i]?.start ?? 0, bars[i]?.end ?? 0, i][d],
      coord: ([x, y]: [number, number]) => [x / 10, y * 18],
    });
    const cs = { coordSys: { x: 0, y: 0, width: 100, height: 100 } };
    const root = renderItem(cs, api(0)).children;
    const label = root.find((c) => c.type === 'text');
    expect(label?.style?.text).toBe(`web · ${HOSTILE}`);
    expect(root.some((c) => c.type === 'rect' && c.style?.stroke === THEME.ink)).toBe(false);
    const failing = renderItem(cs, api(1)).children;
    expect(failing.some((c) => c.style?.stroke === THEME.critical)).toBe(true);
    expect(failing.some((c) => c.style?.stroke === THEME.ink)).toBe(true);
    // The error label is prefixed so colour is never the only cue.
    expect(String(failing.find((c) => c.type === 'text')?.style?.text ?? '✕')).toContain('✕');
  });

  test('outlineSpanId draws a 2px accent outline and a label tail on that bar only; narrow outlined bars stay unmerged', () => {
    const o = flameOption(bars, THEME, { ...view, selectedSpanId: null, outlineSpanId: spanIdOf(2) });
    const s = Array.isArray(o.series) ? o.series[0] : o.series;
    const renderItem = (s as { renderItem: (p: unknown, a: unknown) => { children: Shape[] } }).renderItem;
    const api = (i: number) => ({
      value: (d: number) => [bars[i]?.depth ?? 0, bars[i]?.start ?? 0, bars[i]?.end ?? 0, i][d],
      coord: ([x, y]: [number, number]) => [x, y * 18],
    });
    const cs = { coordSys: { x: 0, y: 0, width: 600, height: 100 } };
    const hit = renderItem(cs, api(1)).children;
    const ring = hit.find((c) => c.style?.stroke === THEME.accent);
    expect(ring?.style).toMatchObject({ stroke: THEME.accent, lineWidth: 2 });
    expect(hit.find((c) => c.type === 'text')?.style?.text).toContain('← emitted this log');
    const other = renderItem(cs, api(0)).children;
    expect(other.some((c) => c.style?.stroke === THEME.accent)).toBe(false);
    expect(
      buildFlameItems(bars, 10_000, null, spanIdOf(2)).some((i) => i.kind === 'bar' && i.index === 1),
    ).toBe(true);
  });

  test('markers become dashed accent markLines at the marker time', () => {
    const o = flameOption(bars, THEME, {
      ...view,
      markers: [{ time: 250 as RelNanos, label: 'this log' }],
    });
    const s = Array.isArray(o.series) ? o.series[0] : o.series;
    const line = (
      s as {
        markLine?: {
          data: { xAxis: number; label: { formatter: string } }[];
          lineStyle: { color: string; type: string };
        };
      }
    ).markLine;
    expect(line?.data).toHaveLength(1);
    expect(line?.data[0]?.xAxis).toBe(250);
    expect(line?.data[0]?.label.formatter).toBe('this log');
    expect(line?.lineStyle).toMatchObject({ color: THEME.accent, type: 'dashed' });
    const plain = Array.isArray(series) ? series[0] : series;
    expect((plain as { markLine?: unknown }).markLine).toBeUndefined();
  });

  test('the minimap is a second custom series with a slider bound to the same zoom', () => {
    const mini = minimapOption(bars, THEME, { start: 10, end: 40 });
    const dz = Array.isArray(mini.dataZoom) ? mini.dataZoom[0] : mini.dataZoom;
    expect(dz).toMatchObject({ type: 'slider', start: 10, end: 40 });
  });
});

describe('labelColorOn', () => {
  test('picks readable text for light and dark fills', () => {
    expect(labelColorOn('#ffffff', THEME)).toBe('#111111');
    expect(labelColorOn('#0b1020', THEME)).toBe('#ffffff');
    expect(labelColorOn('not-a-colour', THEME)).toBe(THEME.ink);
  });
});

describe('level of detail for big traces', () => {
  const many = (() => {
    const rows = [traceRow(1, null, 0, 1_000_000)];
    for (let i = 2; i <= 3000; i++) {
      rows.push(traceRow(i, 1, i * 100, i * 100 + 50, { service: `s${i % 3}`, error: i % 500 === 0 }));
    }
    return layoutFlame(detailOf(rows).tree, { colorBy: 'service', filter: '', errorsOnly: false }).bars;
  })();

  test('narrow bars are merged per depth, colour and error flag; wide and selected bars stay alone', () => {
    const selected = many[10]?.spanId ?? null;
    const items = buildFlameItems(many, 1000, selected);
    const alone = items.filter((i) => i.kind === 'bar').map((i) => (i.kind === 'bar' ? i.index : -1));
    expect(alone.sort((a, b) => a - b)).toEqual([0, 10]); // the 1 ms root and the selected span
    const batches = items.filter((i) => i.kind === 'batch');
    expect(batches.length).toBeLessThanOrEqual(3 * 2); // 3 colours x error or not, all at depth 1
    expect(batches.some((b) => b.kind === 'batch' && b.error)).toBe(true);
    expect(items.reduce((n, i) => n + (i.kind === 'bar' ? 1 : i.indexes.length), 0)).toBe(many.length);
  });

  test('minBarNs 0 keeps one item per bar', () => {
    expect(buildFlameItems(many, 0, null)).toHaveLength(many.length);
  });

  test('batch paths merge bars that touch within half a pixel', () => {
    const option = flameOption(many, THEME, {
      selectedSpanId: null,
      zoom: { start: 0, end: 100 },
      maxRows: 200,
      minBarNs: 1000,
    });
    const series = Array.isArray(option.series) ? option.series[0] : option.series;
    const renderItem = (series as { renderItem: (p: unknown, a: unknown) => { shape?: { d: string } } })
      .renderItem;
    const data = (series as { data: number[][] }).data;
    const at = data.findIndex(
      (r) => r[0] === 1 && r[3] !== undefined && r[2] !== undefined && r[1] !== undefined,
    );
    const api = {
      value: (d: number) => data[at]?.[d],
      coord: ([x]: [number, number]) => [x / 1_000_000, 0], // 1 px = 1 ms: every 50 ns bar is sub-pixel
    };
    const out = renderItem({ coordSys: { x: 0, y: 0, width: 1000, height: 40 } }, api);
    // 3000 bars collapse to a few rectangles (one `M` each), not thousands.
    expect((out.shape?.d.match(/M/g) ?? []).length).toBeLessThan(20);
  });
});

describe('barAt', () => {
  const { tree } = detailOf([traceRow(1, null, 0, 1000), traceRow(2, 1, 100, 200), traceRow(3, 1, 150, 160)]);
  const { bars } = layoutFlame(tree, { colorBy: 'service', filter: '', errorsOnly: false });

  test('finds the narrowest bar at a depth containing the time', () => {
    expect(barAt(bars, 500, 0, 0)?.spanId).toBe(spanIdOf(1));
    expect(barAt(bars, 155, 1, 0)?.spanId).toBe(spanIdOf(3));
    expect(barAt(bars, 120, 1, 0)?.spanId).toBe(spanIdOf(2));
  });

  test('misses empty space, and the tolerance keeps sub-pixel bars clickable', () => {
    expect(barAt(bars, 500, 1, 0)).toBeNull();
    expect(barAt(bars, 162, 1, 0)?.spanId).toBe(spanIdOf(2));
    expect(barAt(bars, 163, 1, 5)?.spanId).toBe(spanIdOf(3));
  });
});

describe('sampleForOverview', () => {
  test('keeps small traces whole; samples big ones to the cap, keeping errors and the longest bars', () => {
    const rows = [traceRow(1, null, 0, 10_000)];
    for (let i = 2; i <= 500; i++)
      rows.push(traceRow(i, 1, i, i + (i === 250 ? 5000 : 2), { error: i === 7 }));
    const { bars } = layoutFlame(detailOf(rows).tree, { colorBy: 'service', filter: '', errorsOnly: false });
    expect(sampleForOverview(bars, 1000)).toBe(bars);
    const sampled = sampleForOverview(bars, 20);
    expect(sampled).toHaveLength(20);
    expect(sampled.some((b) => b.spanId === spanIdOf(7))).toBe(true);
    expect(sampled.some((b) => b.spanId === spanIdOf(250))).toBe(true);
    expect(sampled[0]?.spanId).toBe(spanIdOf(1)); // original order kept
  });
});

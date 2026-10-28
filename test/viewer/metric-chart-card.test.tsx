import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

interface Zr {
  on: (name: string, h: (e: unknown) => void) => void;
  off: () => void;
}
const zrHandlers = new Map<string, (e: unknown) => void>();
const plot = { inside: true, scale: 1e9 };
const fakeChart = {
  containPixel: (): boolean => plot.inside,
  getZr: (): Zr => ({ on: (n, h) => zrHandlers.set(n, h), off: () => undefined }),
  // 1 px per second on x; y is ignored.
  convertFromPixel: (_f: unknown, p: [number, number]): [number, number] => [p[0] * plot.scale, p[1]],
  convertToPixel: (_f: unknown, p: [number, number]): [number, number] => [p[0] / 1e9, p[1]],
};

vi.mock('../../src/viewer/components/chart.js', async () => {
  const { useEffect } = await import('react');
  return {
    Chart: (p: {
      ariaLabel: string;
      option: unknown;
      onInstance?: (c: unknown) => void;
    }): React.JSX.Element => {
      useEffect(() => {
        p.onInstance?.(fakeChart);
        return () => p.onInstance?.(null);
      }, [p.onInstance]);
      return <div role="img" aria-label={p.ariaLabel} />;
    },
  };
});

import { type ChartPick, MetricChartCard } from '../../src/viewer/components/metric-chart-card.js';
import type { MetricQueryResult } from '../../src/viewer/data/metric-query.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  cleanup();
  plot.inside = true;
  plot.scale = 1e9;
  zrHandlers.clear();
});

const S = 1e9;
const HOSTILE = '</script><img src=x onerror=alert(1)> ';

function result(withExemplar: boolean, label = 'a'): MetricQueryResult {
  return {
    queryId: 'q1',
    widthNs: 10 * S,
    series: [
      {
        key: 'a',
        label,
        group: {},
        unit: 's',
        points: [
          [0, 1],
          [10 * S, 2],
        ],
        resourceService: null,
      },
    ],
    exemplars: withExemplar ? [{ time: 5 * S, value: 1, traceId: 'tt', spanId: 'ss', seriesKey: 'a' }] : [],
    heat: null,
    distribution: null,
    notes: [],
  };
}

function setup(over: {
  exemplar?: boolean;
  hasTrace?: (id: string) => Promise<boolean>;
  title?: string;
  notes?: string[];
  display?: 'lines' | 'heatmap' | 'distribution';
  result?: MetricQueryResult;
  results?: MetricQueryResult[];
  queryLabels?: Record<string, string>;
}): { picks: ChartPick[]; zooms: { start: number; end: number }[] } {
  const picks: ChartPick[] = [];
  const zooms: { start: number; end: number }[] = [];
  render(
    <MetricChartCard
      title={over.title ?? 'cpu'}
      subtitle="sub"
      results={over.results ?? [over.result ?? result(over.exemplar === true)]}
      {...(over.queryLabels === undefined ? {} : { queryLabels: over.queryLabels })}
      display={over.display ?? 'lines'}
      scale="linear"
      size="M"
      exemplars={over.exemplar === true}
      notes={over.notes ?? []}
      window={{ start: 0, end: 20 * S }}
      hasTrace={over.hasTrace ?? (() => Promise.resolve(true))}
      onPick={(p) => picks.push(p)}
      onZoom={(w) => zooms.push(w)}
    />,
  );
  return { picks, zooms };
}

async function clickAt(x: number, y = 0): Promise<void> {
  await act(async () => {
    zrHandlers.get('click')?.({ offsetX: x, offsetY: y, event: { clientX: x, clientY: y } });
  });
}

async function drag(from: number, to: number): Promise<void> {
  const at = (x: number): unknown => ({ offsetX: x, offsetY: 0, event: { clientX: x, clientY: 0 } });
  await act(async () => {
    zrHandlers.get('mousedown')?.(at(from));
    zrHandlers.get('mouseup')?.(at(to));
  });
}

const HEAT: MetricQueryResult = {
  ...result(false),
  heat: {
    bounds: [1],
    cells: [
      [20 * S, 0, 1],
      [40 * S, 1, 2],
    ],
  },
};

/** Query `id` with one series of `values` at 0 s and 10 s (the fake chart maps a value to that many px in y). */
function queryResult(id: string, values: [number, number]): MetricQueryResult {
  const base = result(false, id);
  return {
    ...base,
    queryId: id,
    series: base.series.map((s) => ({
      ...s,
      key: id,
      points: [
        [0, values[0]],
        [10 * S, values[1]],
      ],
    })),
  };
}

describe('MetricChartCard with several queries', () => {
  const TWO = [queryResult('a', [1, 2]), queryResult('b', [50, 60])];

  test("Traces/Logs carry the query whose line is nearest the click, not the first query's", async () => {
    const { picks } = setup({ results: TWO });
    await clickAt(12, 58);
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Traces in this window',
      'Logs in this window',
      'Zoom to this window',
    ]);
    await act(async () => items[0]?.click());
    expect(picks).toEqual([{ kind: 'traces', window: { start: 10 * S, end: 20 * S }, queryId: 'b' }]);
    cleanup();
    zrHandlers.clear();
    const near = setup({ results: TWO });
    await clickAt(12, 3);
    await act(async () => (await screen.findAllByRole('menuitem'))[1]?.click());
    expect(near.picks).toEqual([{ kind: 'logs', window: { start: 10 * S, end: 20 * S }, queryId: 'a' }]);
  });

  test('with no value in the clicked bucket the menu offers one Traces and Logs entry per query', async () => {
    const { picks } = setup({ results: TWO, queryLabels: { a: 'a', b: 'errors' } });
    await clickAt(25, 58);
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Traces in this window (a)',
      'Traces in this window (errors)',
      'Logs in this window (a)',
      'Logs in this window (errors)',
      'Zoom to this window',
    ]);
    await act(async () => items[3]?.click());
    expect(picks).toEqual([{ kind: 'logs', window: { start: 20 * S, end: 30 * S }, queryId: 'b' }]);
  });
});

describe('MetricChartCard', () => {
  test('a click over a bucket opens a menu with three items', async () => {
    const { picks } = setup({});
    await clickAt(12);
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Traces in this window',
      'Logs in this window',
      'Zoom to this window',
    ]);
    await act(async () => items[2]?.click());
    expect(picks).toEqual([{ kind: 'zoom', window: { start: 10 * S, end: 20 * S } }]);
  });

  test('a click on an exemplar adds the trace item first', async () => {
    const { picks } = setup({ exemplar: true, hasTrace: () => Promise.resolve(true) });
    await clickAt(5);
    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(4);
    await act(async () => items[0]?.click());
    expect(picks).toEqual([{ kind: 'exemplar', traceId: 'tt', spanId: 'ss' }]);
  });

  test('an exemplar whose trace the report lacks is a disabled item', async () => {
    setup({ exemplar: true, hasTrace: () => Promise.resolve(false) });
    await clickAt(5);
    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(4);
    expect(items[0]?.textContent).toBe('trace not in this report');
    expect(items[0]?.getAttribute('aria-disabled')).toBe('true');
  });

  test('notes render under the title as a list', () => {
    setup({ notes: ['3 series folded into other'] });
    expect(screen.getByRole('list', { name: 'Notes' }).textContent).toBe('3 series folded into other');
  });

  test('hostile title, subtitle and notes render as text', () => {
    setup({ title: HOSTILE, notes: [HOSTILE] });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(HOSTILE);
    expect(screen.getByRole('list', { name: 'Notes' }).textContent).toBe(HOSTILE);
  });

  test('a lookup that rejects shows a disabled "trace lookup failed" item', async () => {
    setup({ exemplar: true, hasTrace: () => Promise.reject(new Error('boom')) });
    await clickAt(5);
    const items = await screen.findAllByRole('menuitem');
    expect(items[0]?.textContent).toBe('trace lookup failed');
    expect(items[0]?.getAttribute('aria-disabled')).toBe('true');
  });

  test('dragging over the plot calls onZoom with the dragged span', async () => {
    const { zooms } = setup({});
    await drag(15, 3);
    expect(zooms).toEqual([{ start: 3 * S, end: 15 * S }]);
  });

  test('a click outside the plot grid opens nothing', async () => {
    setup({});
    plot.inside = false;
    await clickAt(12);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  test('a slow lookup from an earlier click does not replace a later menu', async () => {
    let release: (ok: boolean) => void = () => undefined;
    const slow = new Promise<boolean>((r) => {
      release = r;
    });
    let calls = 0;
    setup({ exemplar: true, hasTrace: () => (calls++ === 0 ? slow : Promise.resolve(false)) });
    await clickAt(5); // slow: pending
    await clickAt(5); // fast: absent
    await screen.findAllByRole('menuitem');
    await act(async () => release(true));
    const items = await screen.findAllByRole('menuitem');
    expect(items[0]?.textContent).toBe('trace not in this report');
  });

  test('a heatmap click maps the category index back to its bucket time', async () => {
    const { picks } = setup({ display: 'heatmap', result: HEAT });
    plot.scale = 1; // pixel x is the category index
    await clickAt(1);
    const items = await screen.findAllByRole('menuitem');
    await act(async () => items[0]?.click());
    expect(picks).toEqual([{ kind: 'traces', queryId: 'q1', window: { start: 30 * S, end: 40 * S } }]);
  });

  test('a distribution has no time axis: no menu and no drag-zoom', async () => {
    const { zooms } = setup({ display: 'distribution' });
    await clickAt(12);
    await drag(15, 3);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(zooms).toEqual([]);
  });
});

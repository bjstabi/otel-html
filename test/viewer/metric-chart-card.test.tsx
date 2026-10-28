import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

interface Zr {
  on: (name: string, h: (e: unknown) => void) => void;
  off: () => void;
}
const zrHandlers = new Map<string, (e: unknown) => void>();
const fakeChart = {
  getZr: (): Zr => ({ on: (n, h) => zrHandlers.set(n, h), off: () => undefined }),
  // 1 px per second on x; y is ignored.
  convertFromPixel: (_f: unknown, p: [number, number]): [number, number] => [p[0] * 1e9, p[1]],
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
}): { picks: ChartPick[] } {
  const picks: ChartPick[] = [];
  render(
    <MetricChartCard
      title={over.title ?? 'cpu'}
      subtitle="sub"
      results={[result(over.exemplar === true)]}
      display="lines"
      scale="linear"
      size="M"
      exemplars={over.exemplar === true}
      notes={over.notes ?? []}
      window={{ start: 0, end: 20 * S }}
      {...(over.hasTrace === undefined ? {} : { hasTrace: over.hasTrace })}
      onPick={(p) => picks.push(p)}
      onZoom={() => undefined}
    />,
  );
  return { picks };
}

async function clickAt(x: number): Promise<void> {
  await act(async () => {
    zrHandlers.get('click')?.({ offsetX: x, offsetY: 0, event: { clientX: x, clientY: 0 } });
  });
}

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
});

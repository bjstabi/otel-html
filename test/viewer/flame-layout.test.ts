import { describe, expect, test } from 'vitest';
import { layoutFlame } from '../../src/viewer/components/flame-layout.js';
import { medianMs } from './median-ms.js';
import { detailOf, spanIdOf, traceRow } from './trace-rows.js';

const OPTS = { colorBy: 'service', filter: '', errorsOnly: false } as const;
declare const process: { env: { OTEL_HTML_PERF_FACTOR?: string } }; // provided by vitest; the viewer project has no node types
const perfFactor = Number(process.env.OTEL_HTML_PERF_FACTOR ?? '1');

describe('layoutFlame', () => {
  test('a 3-span sequential trace has depths [0,1,1] and shares summing to 1', () => {
    const { tree } = detailOf([
      traceRow(1, null, 0, 100, { service: 'web' }),
      traceRow(2, 1, 0, 40, { service: 'db' }),
      traceRow(3, 1, 50, 90, { service: 'db' }),
    ]);
    const { bars, legend } = layoutFlame(tree, OPTS);
    expect(bars.map((b) => b.depth)).toEqual([0, 1, 1]);
    expect(bars.map((b) => [b.start, b.end])).toEqual([
      [0, 100],
      [0, 40],
      [50, 90],
    ]);
    expect(legend.reduce((a, l) => a + l.share, 0)).toBeCloseTo(1, 10);
    // web is exclusive for 100 - 80 = 20 of 100; db for 80.
    expect(legend).toEqual([
      { key: 'db', share: 0.8 },
      { key: 'web', share: 0.2 },
    ]);
  });

  test('errorsOnly dims non-error bars without removing them', () => {
    const { tree } = detailOf([
      traceRow(1, null, 0, 100),
      traceRow(2, 1, 10, 20, { error: true }),
      traceRow(3, 1, 30, 40),
    ]);
    const { bars } = layoutFlame(tree, { ...OPTS, errorsOnly: true });
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => [b.error, b.dimmed])).toEqual([
      [false, true],
      [true, false],
      [false, true],
    ]);
  });

  test('the text filter dims non-matching bars (name or service, case-insensitive)', () => {
    const { tree } = detailOf([
      traceRow(1, null, 0, 100, { name: 'GET /a', service: 'web' }),
      traceRow(2, 1, 10, 20, { name: 'SELECT', service: 'db' }),
    ]);
    const { bars } = layoutFlame(tree, { ...OPTS, filter: 'select' });
    expect(bars.map((b) => b.dimmed)).toEqual([true, false]);
    expect(layoutFlame(tree, { ...OPTS, filter: 'WEB' }).bars.map((b) => b.dimmed)).toEqual([false, true]);
  });

  test('an orphan subtree renders at depth 0 after the main root, with its children below it', () => {
    const { tree } = detailOf([
      traceRow(1, null, 0, 100),
      traceRow(2, 1, 10, 20),
      traceRow(7, 99, 120, 150), // parent 99 never arrived
      traceRow(8, 7, 125, 130),
    ]);
    const { bars } = layoutFlame(tree, OPTS);
    expect(bars.map((b) => [b.spanId, b.depth])).toEqual([
      [spanIdOf(1), 0],
      [spanIdOf(2), 1],
      [spanIdOf(7), 0],
      [spanIdOf(8), 1],
    ]);
  });

  test('zero-duration spans and children outside their parent keep their own extents', () => {
    const { tree } = detailOf([
      traceRow(1, null, 100, 200),
      traceRow(2, 1, 50, 50), // starts before its parent, zero duration
      traceRow(3, 1, 190, 260), // ends after its parent
    ]);
    const { bars, legend } = layoutFlame(tree, OPTS);
    expect(bars.map((b) => [b.start, b.end, b.depth])).toEqual([
      [100, 200, 0],
      [50, 50, 1],
      [190, 260, 1],
    ]);
    expect(legend.reduce((a, l) => a + l.share, 0)).toBeCloseTo(1, 10);
  });

  test('colour indexes follow the colour-by key; the same key keeps the same index', () => {
    const { tree } = detailOf([
      traceRow(1, null, 0, 100, { service: 'web' }),
      traceRow(2, 1, 10, 20, { service: 'db' }),
      traceRow(3, 1, 30, 40, { service: 'db' }),
    ]);
    const { bars } = layoutFlame(tree, OPTS);
    expect(bars[1]?.colorIndex).toBe(bars[2]?.colorIndex);
    expect(bars[0]?.colorIndex).not.toBe(bars[1]?.colorIndex);
  });

  test('labels join service and span name verbatim (no markup interpretation)', () => {
    const { tree } = detailOf([
      traceRow(1, null, 0, 10, { service: 's', name: '</script><img onerror=x> ' }),
    ]);
    expect(layoutFlame(tree, OPTS).bars[0]?.label).toBe('s · </script><img onerror=x> ');
  });

  test('lays out 50k spans within the budget', () => {
    const rows = [traceRow(1, null, 0, 50_000_000)];
    for (let i = 2; i <= 50_000; i++) {
      const parent = Math.max(1, Math.floor(i / 4));
      rows.push(traceRow(i, parent, i * 100, i * 100 + 50, { service: `s${i % 5}` }));
    }
    const { tree } = detailOf(rows);
    const { result, ms } = medianMs(() => layoutFlame(tree, OPTS));
    const { bars } = result;
    expect(bars).toHaveLength(50_000);
    expect(ms).toBeLessThan(1500 * perfFactor);
  });
});

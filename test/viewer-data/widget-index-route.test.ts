import { describe, expect, test } from 'vitest';
import { conditionId, WIDGET_INDEX_EVALUATOR } from '../../src/config/widget-traces.js';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { routeWidgetIndex } from '../../src/viewer/data/widget-index-route.js';

const QUERY = 'name == "x"';
const ID = conditionId(QUERY);
const stats = { rows: 1, bytes: 1, values: {}, min: {}, max: {}, nulls: {} };

type Entry = { conditions: string[]; variables: string[]; evaluator?: number };

function manifestOf(entries: readonly (null | Entry)[]): ManifestV4 {
  return {
    partitions: entries.map((index, i) => ({
      n: i,
      files: {
        spans: { path: `data/partitions/00000${i}/spans.parquet`, ...stats },
        ...(index === null
          ? {}
          : {
              widget_traces: {
                path: `data/partitions/00000${i}/widget_traces.parquet`,
                ...stats,
                widgetIndex: index,
              },
            }),
      },
    })),
  } as unknown as ManifestV4;
}

const spans = (n: number): string => `data/partitions/00000${n}/spans.parquet`;
const scan = (...ns: number[]) => ({ files: ns.map(spans), all: true, total: ns.length });
const hint = (keys: string[]) => ({
  query: QUERY,
  variables: null,
  bindings: keys.map((key) => ({ key, value: 'v' })),
});

describe('routeWidgetIndex', () => {
  const m = manifestOf([
    { conditions: [ID], variables: ['a', 'b'], evaluator: WIDGET_INDEX_EVALUATOR },
    null,
    { conditions: [ID], variables: ['a'], evaluator: WIDGET_INDEX_EVALUATOR },
    { conditions: ['0000000000000000'], variables: ['a', 'b'], evaluator: WIDGET_INDEX_EVALUATOR },
  ]);

  test('partitions with a covering index move; the others stay in the scan', () => {
    const r = routeWidgetIndex(m, scan(0, 1, 2, 3), hint(['a', 'b']));
    expect(r.scan).toEqual({ files: [spans(1), spans(2), spans(3)], all: false, total: 4 });
    expect(r.route).toEqual({
      files: ['data/partitions/000000/widget_traces.parquet'],
      condition: ID,
      bindings: [
        { key: 'a', value: 'v' },
        { key: 'b', value: 'v' },
      ],
    });
  });

  test('a partition whose index lacks a bound key scans; with fewer keys it routes', () => {
    const r = routeWidgetIndex(m, scan(0, 2), hint(['a']));
    expect(r.route?.files).toEqual([
      'data/partitions/000000/widget_traces.parquet',
      'data/partitions/000002/widget_traces.parquet',
    ]);
    expect(r.scan.files).toEqual([]);
  });

  test('nothing moved: the scan is returned as it was and the route is null', () => {
    const s = scan(1, 3);
    expect(routeWidgetIndex(m, s, hint([]))).toEqual({ scan: s, route: null });
  });

  test('a partition routes only when its index was written by this evaluator version', () => {
    const covering = { conditions: [ID], variables: ['a'] };
    const v = manifestOf([{ ...covering, evaluator: 1 }, covering, { ...covering, evaluator: 2 }]);
    const r = routeWidgetIndex(v, scan(0, 1, 2), hint(['a']));
    expect(r.route?.files).toEqual(['data/partitions/000000/widget_traces.parquet']);
    expect(r.scan.files).toEqual([spans(1), spans(2)]);
    const none = routeWidgetIndex(
      manifestOf([covering, { ...covering, evaluator: 2 }]),
      scan(0, 1),
      hint([]),
    );
    expect(none.route).toBeNull();
  });

  test('only files of the scan move', () => {
    const r = routeWidgetIndex(m, scan(2), hint([]));
    expect(r.route?.files).toEqual(['data/partitions/000002/widget_traces.parquet']);
  });
});

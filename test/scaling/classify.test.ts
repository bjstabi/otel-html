import { describe, expect, test } from 'vitest';
import { classify, FILES_PER_PARTITION, type Step } from '../../test-support/scaling/classify.js';

/** Three steps over 2, 4 and 8 partitions; `at(i)` gives the per-step values. */
function series(at: (i: number, partitions: number) => Partial<Step>): Step[] {
  return [2, 4, 8].map((partitions, i) => ({
    partitions,
    selectedGroups: partitions * 2,
    neededGroups: partitions * 2,
    reference: 10,
    cost: { serial: 10, parallel: 0, bytes: 1000 },
    ...at(i, partitions),
  }));
}

describe('classify', () => {
  test('fixed: nothing changes, bytes within 10 %', () => {
    expect(classify(series((i) => ({ cost: { serial: 6, parallel: 1, bytes: 1000 + i * 40 } })))).toBe(
      'fixed',
    );
  });

  test('fixed fails when bytes grow by more than 10 %', () => {
    expect(classify(series((i) => ({ cost: { serial: 6, parallel: 1, bytes: 1000 * (1 + i) } })))).not.toBe(
      'fixed',
    );
  });

  test('files: serial equal, parallel grows by FILES_PER_PARTITION per partition, bytes may grow', () => {
    expect(
      classify(
        series((_i, partitions) => ({
          cost: { serial: 4, parallel: FILES_PER_PARTITION * partitions, bytes: 1000 * partitions },
        })),
      ),
    ).toBe('files');
  });

  test('files fails when parallel grows faster than FILES_PER_PARTITION', () => {
    expect(
      classify(
        series((_i, partitions) => ({
          cost: { serial: 4, parallel: (FILES_PER_PARTITION + 1) * partitions, bytes: 1000 },
        })),
      ),
    ).toBe('scan');
  });

  test('matched: the needed groups grow slower than the selected ones and serial follows the needed groups', () => {
    expect(
      classify(
        series((i) => ({
          neededGroups: 2 + i,
          selectedGroups: 4 + 6 * i,
          reference: 10 + 12 * i,
          cost: { serial: 10 + 2 * i, parallel: 0, bytes: 1000 },
        })),
      ),
    ).toBe('matched');
  });

  test('scan: serial grows with the rows', () => {
    expect(
      classify(series((_i, partitions) => ({ cost: { serial: 2 * partitions, parallel: 0, bytes: 1 } }))),
    ).toBe('scan');
  });

  test('serial growth of one request per step is not fixed', () => {
    const steps = series((i) => ({ cost: { serial: 6 + i, parallel: 0, bytes: 1000 }, neededGroups: 4 }));
    expect(classify(steps)).not.toBe('fixed');
    expect(classify(steps)).not.toBe('files');
  });

  test('a matched series whose needed groups grow as fast as the selected ones is scan', () => {
    expect(
      classify(
        series((_i, partitions) => ({
          reference: 3 * partitions,
          cost: { serial: 3 * partitions, parallel: 0, bytes: 1 },
        })),
      ),
    ).toBe('scan');
  });
});

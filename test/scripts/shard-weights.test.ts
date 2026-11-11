import { describe, expect, it } from 'vitest';
import { normalise, playwrightSeconds } from '../../scripts/shard-weights.ts';

describe('playwrightSeconds', () => {
  it('sums test durations per spec file across projects and nested suites', () => {
    const report = {
      suites: [
        {
          file: 'a.spec.ts',
          specs: [
            {
              file: 'a.spec.ts',
              tests: [{ results: [{ duration: 1200 }] }, { results: [{ duration: 800 }] }],
            },
          ],
          suites: [
            { file: 'a.spec.ts', specs: [{ file: 'a.spec.ts', tests: [{ results: [{ duration: 1000 }] }] }] },
          ],
        },
        {
          file: 'sub/b.spec.ts',
          specs: [{ file: 'sub/b.spec.ts', tests: [{ results: [{ duration: 20 }] }] }],
        },
      ],
    };
    expect(playwrightSeconds(report)).toEqual({ 'a.spec.ts': 3, 'b.spec.ts': 0.1 });
  });
});

describe('normalise', () => {
  it('sorts keys and rounds to a tenth, at least 0.1', () => {
    const out = normalise({ b: 1.26, a: 0.01 });
    expect(Object.entries(out)).toEqual([
      ['a', 0.1],
      ['b', 1.3],
    ]);
  });
});

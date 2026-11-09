import { describe, expect, test } from 'vitest';
import { GroupDurations } from '../../src/rollups/span-rollups.js';

describe('GroupDurations', () => {
  test('past the cap a new group is dropped and counted; an existing group still accumulates', () => {
    const g = new GroupDurations(2);
    g.add('a', 1);
    g.add('b', 2);
    g.add('c', 3);
    g.add('a', 4);
    expect(g.size).toBe(2);
    expect(g.get('c')).toBeUndefined();
    expect(g.get('a')?.count).toBe(2);
    expect(g.dropped).toBe(1);
    g.add('c', 5);
    expect(g.dropped).toBe(2);
    expect(g.cap).toBe(2);
  });
});

import { describe, expect, test } from 'vitest';
import type { Widget } from '../../../src/dashboards/schema.js';
import '../../../src/viewer/cicd/registrations.js';
import { fixedScope, honours, opensRuns } from '../../../src/viewer/dashboards/scope.js';

const base = { id: 'w1', title: null, x: 0, y: 0, w: 6, h: 6, follow: true };
const WIDGETS = {
  timeline: { ...base, type: 'timeline' },
  table: { ...base, type: 'table' },
};

describe('cicd registrations', () => {
  const variable = (key: string) => ({ key, label: key, default: null });
  test('a cicd view honours the variables of the CI keys per the spec table', () => {
    const cicd = (view: string): Widget => ({ ...WIDGETS.timeline, type: 'cicd', view }) as unknown as Widget;
    const job = variable('cicd.pipeline.task.name');
    const runner = variable('cicd.worker.labels');
    const branch = variable('vcs.ref.head.name');
    const trigger = variable('cicd.pipeline.trigger');
    expect(honours(cicd('runs'), job)).toBe(false);
    expect(honours(cicd('runs'), runner)).toBe(false);
    expect(honours(cicd('runs'), branch)).toBe(true);
    expect(honours(cicd('triggers'), trigger)).toBe(true);
    expect(honours(cicd('jobs'), job)).toBe(true);
    expect(honours(cicd('failures'), job)).toBe(true);
    expect(honours(cicd('failures'), runner)).toBe(false);
    expect(honours(cicd('queue'), runner)).toBe(true);
    expect(honours(cicd('runs'), variable('service.name'))).toBe(false);
  });

  test('the tests view has the fixed scope latest run; others none', () => {
    const cicd = (view: string): Widget => ({ ...WIDGETS.timeline, type: 'cicd', view }) as unknown as Widget;
    expect(fixedScope(cicd('tests'))).toBe('latest run');
    expect(fixedScope(cicd('runs'))).toBeNull();
  });

  test('a cicd widget opens runs; a generic one does not', () => {
    expect(opensRuns({ ...WIDGETS.timeline, type: 'cicd', view: 'runs' } as unknown as Widget)).toBe(true);
    expect(opensRuns(WIDGETS.table as unknown as Widget)).toBe(false);
  });
});

import { expect, test } from 'vitest';
import { BRANCH_KEY, branchLink, runsWindow, windowText } from '../../../src/cli/ci/report-links.js';
import type { SiteRun } from '../../../src/cli/ci/site.js';
import { parseDashboardParam } from '../../../src/viewer/state/dashboard-state.js';

const run = (over: Partial<SiteRun>): SiteRun => ({
  runId: 1,
  attempt: 1,
  conclusion: 'success',
  headSha: 'abc',
  headBranch: 'main',
  completedAt: '2026-01-01T00:00:00Z',
  runUrl: 'u',
  reportPath: 'p',
  ...over,
});
const ns = (iso: string): bigint => BigInt(Date.parse(iso)) * 1_000_000n;

test('branchLink selects the branch, with and without a window', () => {
  const w = { start: ns('2026-01-01T00:00:00Z'), end: ns('2026-01-02T00:00:00Z') };
  const withWindow = branchLink('branch/main/', 'ci', 'feat/x y', w);
  expect(withWindow.startsWith('branch/main/#/dashboards/ci?')).toBe(true);
  const q = new URLSearchParams(withWindow.slice(withWindow.indexOf('?') + 1));
  expect(q.get('t')).toBe(windowText(w));
  expect(withWindow).toContain(`t=${windowText(w)}`);
  const parsed = parseDashboardParam(q.get('d') ?? '');
  expect(parsed.ok && parsed.state.vars[BRANCH_KEY]).toBe('feat/x y');

  const bare = branchLink('branch/main/', 'ci', 'feat', null);
  const q2 = new URLSearchParams(bare.slice(bare.indexOf('?') + 1));
  expect(q2.has('t')).toBe(false);
  const parsed2 = parseDashboardParam(q2.get('d') ?? '');
  expect(parsed2.ok && parsed2.state.vars[BRANCH_KEY]).toBe('feat');
});

test('runsWindow spans the runs with an hour each side; null for none', () => {
  expect(runsWindow([])).toBeNull();
  const w = runsWindow([
    run({ startedAt: '2026-01-02T00:00:00Z', completedAt: '2026-01-02T00:10:00Z' }),
    run({ runId: 2, completedAt: '2026-01-01T12:00:00Z' }),
    run({ runId: 3, startedAt: '2026-01-03T00:00:00Z', completedAt: '2026-01-03T00:30:00Z' }),
  ]);
  expect(w).toEqual({ start: ns('2026-01-01T11:00:00Z'), end: ns('2026-01-03T01:30:00Z') });
  expect(windowText(w ?? { start: 0n, end: 0n })).toBe(
    `${ns('2026-01-01T11:00:00Z')}~${ns('2026-01-03T01:30:00Z')}`,
  );
});

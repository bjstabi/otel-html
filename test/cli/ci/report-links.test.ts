import { expect, test } from 'vitest';
import { resolveApiConfig, resolveDeps } from '../../../src/api/report.js';
import {
  BRANCH_KEY,
  branchLink,
  dashboardIdOf,
  dashboardIds,
  runLink,
  runsWindow,
  windowText,
  withBranchDefault,
} from '../../../src/cli/ci/report-links.js';
import type { SiteRun } from '../../../src/cli/ci/site.js';
import { parseDashboardParam } from '../../../src/viewer/state/dashboard-state.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

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

const configOf = async (path?: string) =>
  resolveApiConfig(
    await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' }),
    path,
    undefined,
  );

test('dashboardIds of .github/otel-html-ci.yaml is ci / w8; of the built-in config the runs widget is undefined', async () => {
  expect(dashboardIds(await configOf('.github/otel-html-ci.yaml'))).toEqual({
    dashboard: 'ci',
    runsWidget: 'w8',
  });
  expect(dashboardIds(await configOf()).runsWidget).toBeUndefined();
});

test('dashboardIds with a workflow picks a runs widget that lists it', async () => {
  const c = await configOf('.github/otel-html-ci.yaml');
  expect(dashboardIds(c, 'ci').runsWidget).toBe('w8');
  expect(dashboardIds(c, 'load').runsWidget).toBeUndefined();
});

test('runLink carries the variables it is given', () => {
  const url = runLink(
    'b/',
    { dashboard: 'ci', runsWidget: 'w8' },
    { traceId: '0123456789abcdef0123456789abcdef', range: { start: 1n, end: 2n } },
    { [BRANCH_KEY]: 'feat' },
  );
  const d = parseDashboardParam(new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('d') ?? '');
  expect(d.ok && d.state.vars).toEqual({ [BRANCH_KEY]: 'feat' });
});

test('withBranchDefault sets the branch variable default and nothing else', async () => {
  const c = await configOf('.github/otel-html-ci.yaml');
  const r = withBranchDefault(c, 'main');
  const ci = r.dashboards.find((d) => d.dashboard.id === 'ci')?.dashboard;
  const ciBefore = c.dashboards.find((d) => d.dashboard.id === 'ci')?.dashboard;
  expect(ci?.variables.find((v) => v.key === BRANCH_KEY)?.default).toBe('main');
  expect(ci?.variables.filter((v) => v.key !== BRANCH_KEY)).toEqual(
    ciBefore?.variables.filter((v) => v.key !== BRANCH_KEY),
  );
  expect(ci?.widgets).toEqual(ciBefore?.widgets);
});

test('runLink opens the run: window start-7d to end+1h, the trace selected, the run pane from the runs widget', () => {
  const range = { start: ns('2026-01-10T00:00:00Z'), end: ns('2026-01-10T00:10:00Z') };
  const url = runLink(
    'https://x/branch/main/',
    { dashboard: 'ci', runsWidget: 'w8' },
    { traceId: '0123456789abcdef0123456789abcdef', range },
  );
  expect(url.startsWith('https://x/branch/main/#/dashboards/ci?')).toBe(true);
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  expect(q.get('t')).toBe(`${ns('2026-01-03T00:00:00Z')}~${ns('2026-01-10T01:10:00Z')}`);
  expect(url).not.toContain('%7E');
  const d = parseDashboardParam(q.get('d') ?? '');
  expect(d.ok && d.state.sel.trace).toBe('0123456789abcdef0123456789abcdef');
  expect(d.ok && d.state.run).toEqual({ from: 'w8', mode: 'panel' });
  const bare = runLink(
    'b/',
    { dashboard: 'fusion', runsWidget: undefined },
    { traceId: '0123456789abcdef0123456789abcdef', range },
  );
  const d2 = parseDashboardParam(new URLSearchParams(bare.slice(bare.indexOf('?') + 1)).get('d') ?? '');
  expect(d2.ok && d2.state.sel.trace).toBe('0123456789abcdef0123456789abcdef');
  expect(d2.ok && d2.state.run).toBeNull();
});

test('dashboardIdOf reads the id from a run link and is undefined for a plain report url', () => {
  const url = runLink(
    'https://x/branch/main/',
    { dashboard: 'ci', runsWidget: 'w8' },
    {
      traceId: '0123456789abcdef0123456789abcdef',
      range: { start: 1n, end: 2n },
    },
  );
  expect(dashboardIdOf(url)).toBe('ci');
  expect(dashboardIdOf('https://x/pr/5/runs/42/')).toBeUndefined();
});

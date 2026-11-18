import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnyValue } from '../../../src/model/anyvalue.js';
import { RunGantt, runPaneRows } from '../../../src/viewer/cicd/run-gantt.js';
import type { CiJob, CiRun } from '../../../src/viewer/cicd/runs.js';
import type { DataSource } from '../../../src/viewer/data/data-source.js';
import { detailOf, spanIdOf, str, TRACE_ID, traceRow } from '../trace-rows.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEC = 1_000_000_000;
afterEach(cleanup);

function job(
  n: number,
  name: string,
  id: string,
  start: number,
  end: number,
  over: Partial<CiJob> = {},
): CiJob {
  return {
    name,
    id,
    result: 'success',
    start: start * SEC,
    end: end * SEC,
    queuedNs: null,
    labels: null,
    needs: [],
    condition: null,
    failedStep: null,
    spanId: spanIdOf(n),
    ...over,
  };
}

const NAMES = [
  'changes',
  'check',
  'build',
  'lint',
  'unit',
  'e2e',
  'coverage',
  'docs',
  'release',
  'deploy',
  'notify',
];
const jobs: CiJob[] = NAMES.map((name, i) =>
  job(i + 2, name, name, i * 10, i * 10 + 30, {
    needs: name === 'coverage' ? ['changes'] : [],
    queuedNs: name === 'check' ? 5 * SEC : null,
    result: name === 'unit' ? 'failure' : 'success',
  }),
);
const run: CiRun = {
  traceId: TRACE_ID,
  runId: '77',
  attempt: 1,
  attempts: 1,
  start: 0,
  duration: 130 * SEC,
  result: 'failure',
  trigger: 'pull_request',
  branch: 'feat/x',
  revision: 'abcdef1234567',
  title: 'Add things',
  jobs,
  minutes: 5.5,
  replayed: 3,
  ran: 9,
  cached: true,
};

const stepAttrs = (result: string) => new Map([['cicd.pipeline.task.step.result', str(result)]]);
const checkSpan = spanIdOf(3);
const detail = detailOf([
  traceRow(1, null, 0, 130 * SEC),
  traceRow(3, 1, 10 * SEC, 40 * SEC, { name: 'check' }),
  traceRow(40, 3, 11 * SEC, 12 * SEC, { name: 'queued' }),
  traceRow(41, 3, 12 * SEC, 20 * SEC, { name: 'Run mise', attributes: stepAttrs('success') }),
  traceRow(42, 41, 13 * SEC, 15 * SEC, {
    name: 'mise run lint',
    attributes: new Map<string, AnyValue>([
      ['mise.task.name', str('lint')],
      ['mise.task.skipped', { kind: 'bool', value: true }],
    ]),
  }),
  traceRow(43, 41, 15 * SEC, 19 * SEC, {
    name: 'mise run test',
    attributes: new Map([['mise.task.name', str('test')]]),
  }),
  traceRow(44, 3, 20 * SEC, 30 * SEC, { name: 'Upload', attributes: stepAttrs('failure') }),
]);

function mount(getTrace = vi.fn(() => Promise.resolve(detail))): ReturnType<typeof vi.fn> {
  const ds = { getTrace, manifest: { epochUnixNano: '1700000000000000000' } } as unknown as DataSource;
  render(<RunGantt run={run} dataSource={ds} />);
  return getTrace;
}

describe('RunGantt', () => {
  it('shows the summary line and one row per job', () => {
    mount();
    const summary = screen.getByTestId('run-summary').textContent ?? '';
    expect(summary).toContain('feat/x @ abcdef1');
    expect(summary).toContain('pull_request');
    expect(summary).toContain('11 jobs');
    expect(summary).toContain('5.5 CI min');
    expect(document.querySelectorAll('[data-job-row]')).toHaveLength(11);
  });

  it('colours by result, hatches the queue and outlines the last job to finish', () => {
    mount();
    expect(document.querySelector('[data-job-row="unit"] [data-bar]')?.getAttribute('data-result')).toBe(
      'failure',
    );
    expect(document.querySelector('[data-job-row="check"] [data-queue]')).not.toBeNull();
    expect(document.querySelector('[data-job-row="lint"] [data-queue]')).toBeNull();
    const outlined = [...document.querySelectorAll('[data-last="true"]')];
    expect(outlined).toHaveLength(1);
    expect(outlined[0]?.closest('[data-job-row]')?.getAttribute('data-job-row')).toBe('notify');
    expect(document.querySelector('[data-end-line]')).not.toBeNull();
  });

  it('draws an edge from every needed job to the dependent one', () => {
    mount();
    expect(document.querySelectorAll('[data-edge]')).toHaveLength(1);
    expect(document.querySelector('[data-edge="changes>coverage"]')).not.toBeNull();
  });

  it('expanding a job loads the trace once and shows its steps; a step expands to its mise tasks', async () => {
    const getTrace = mount();
    const row = document.querySelector('[data-job-row="check"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /check/ }));
    await waitFor(() => expect(screen.getByText('Run mise')).toBeTruthy());
    expect(screen.getByText('Upload')).toBeTruthy();
    expect(screen.queryByText('queued')).toBeNull();
    expect(getTrace).toHaveBeenCalledTimes(1);
    // a second job's expansion reuses the load
    fireEvent.click(
      within(document.querySelector('[data-job-row="lint"]') as HTMLElement).getByRole('button', {
        name: /lint/,
      }),
    );
    expect(getTrace).toHaveBeenCalledTimes(1);
    // the step with tasks expands to them, the replayed one hatched
    expect(screen.queryByText('lint', { selector: '[data-task-name]' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Run mise/ }));
    const replayed = document.querySelector('[data-task="lint"]');
    expect(replayed?.getAttribute('data-replayed')).toBe('true');
    expect(document.querySelector('[data-task="test"]')?.getAttribute('data-replayed')).toBe('false');
    expect(checkSpan).toBeTruthy();
  });

  it('says so when the trace cannot be read', async () => {
    mount(vi.fn(() => Promise.reject(new Error('nope'))));
    await act(async () => {
      fireEvent.click(
        within(document.querySelector('[data-job-row="check"]') as HTMLElement).getByRole('button', {
          name: /check/,
        }),
      );
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('nope'));
  });
});

describe('runPaneRows', () => {
  it('is ceil((content + 10) / 30)', () => {
    expect(runPaneRows(290)).toBe(10);
    expect(runPaneRows(291)).toBe(11);
    expect(runPaneRows(0)).toBe(1);
  });
});

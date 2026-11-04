// The made-up CI history behind fixtures/ci.otlp.json: runs of this repo's `ci` workflow, its job and step names,
// timings near a real run's, described as the Actions API returns them and turned into OTLP by the code `otel-html ci
// report` uses, so the data carries what a real CI report does. One OTLP/JSON request per line.
import type { ApiJob, ApiRun, ApiStep } from '../src/cli/ci/github-api.js';
import { runKey } from '../src/cli/ci/ids.js';
import { jobLogRecordsRequest } from '../src/cli/ci/job-logs.js';
import { ciMetricsRequest } from '../src/cli/ci/metrics.js';
import { jobIdFor } from '../src/cli/ci/publish.js';
import { ciResource, jobResource, workflowTraceRequest } from '../src/cli/ci/workflow-trace.js';

const REPOSITORY = 'example/otel-html';
const REPO_URL = `https://github.com/${REPOSITORY}`;
export const CI_RUNS = 12;
const RUN_EVERY_S = 3 * 3600;
const FIRST_RUN_ID = 41_600_000_000;
/** The run whose `FAILING_JOB` fails, and the one whose `TIMING_OUT_JOB` hits its 15-minute `timeout-minutes`. */
export const FAILED_RUN = 4;
export const FAILING_JOB = 'e2e (webkit)';
export const TIMED_OUT_RUN = 9;
export const TIMING_OUT_JOB = 'binary (windows-latest, windows-x64, .exe)';
/** ci.yml runs `coverage` on pushes only; on other events the API lists it as skipped, with no steps. */
const PUSH_ONLY = 'coverage';
/** The run that waited for runners. */
const SLOW_QUEUE_RUN = 7;
const JOB_TIMEOUT_S = 15 * 60;

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const CACHE = 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
const UPLOAD = 'Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9';
const CODECOV = 'Run codecov/codecov-action@0fb7174895f61a3b6b78fc075e0cd60383518dac';

/** A step's name and its typical seconds; `main` marks the step that does the job's work (and varies most). */
type StepPlan = { name: string; s: number; main?: true };
/** `afterChanges`: the job `needs: changes`, so it is created when `changes` completes. */
type JobPlan = { name: string; steps: StepPlan[]; afterChanges: boolean };

const containers: StepPlan = { name: 'Initialize containers', s: 25 };
const stopContainers: StepPlan = { name: 'Stop containers', s: 0 };

const setup = (s: number): StepPlan[] => [
  { name: `Run ${CHECKOUT}`, s: 2 },
  { name: 'Run ./.github/actions/setup', s },
];
const otelSetup: StepPlan[] = [
  { name: 'Build otel-html', s: 3 },
  { name: 'Run ./.github/actions/otel-html-setup', s: 1 },
];
const teardown = (cache: boolean): StepPlan[] => [
  { name: 'Run ./.github/actions/otel-html-collect', s: 2 },
  ...(cache ? [{ name: `Post Run ${CACHE}`, s: 1 }] : []),
  { name: 'Post Run ./.github/actions/setup', s: 3 },
  { name: `Post Run ${CHECKOUT}`, s: 1 },
];

const e2e = (name: string, run: StepPlan[]): JobPlan => ({
  name,
  afterChanges: true,
  steps: [
    containers,
    ...setup(15),
    { name: `Run ${CACHE}`, s: 0 },
    ...otelSetup,
    { name: 'Run mise run --skip-deps e2e:otel-recorder', s: 1 },
    { name: 'Run mise run --skip-deps e2e:fixtures', s: 6 },
    ...run,
    { name: UPLOAD, s: 2 },
    ...teardown(true),
    stopContainers,
  ],
});

const binary = (name: string, build: number): JobPlan => ({
  name,
  afterChanges: true,
  steps: [
    ...setup(13),
    ...otelSetup,
    { name: 'Run mise run build:binaries -- --target "$TARGET"', s: build, main: true },
    { name: 'Run pnpm exec vitest run test/cli/binary.test.ts', s: 4 },
    ...teardown(false),
  ],
});

const JOBS: readonly JobPlan[] = [
  {
    name: 'changes',
    afterChanges: false,
    steps: [
      { name: `Run ${CHECKOUT}`, s: 1 },
      {
        name: 'Run # pull_request: base..head; push: before..sha; anything else, or any failure: run everything.',
        s: 1,
      },
      { name: `Post Run ${CHECKOUT}`, s: 1 },
    ],
  },
  {
    name: 'check',
    afterChanges: false,
    steps: [
      ...setup(14),
      { name: `Run ${CACHE}`, s: 1 },
      ...otelSetup,
      { name: 'Run mise run gen:check', s: 2 },
      { name: 'Run mise run check', s: 161, main: true },
      ...teardown(true),
    ],
  },
  {
    name: 'build',
    afterChanges: false,
    steps: [
      ...setup(17),
      ...otelSetup,
      { name: 'Run mise run --skip-deps check:package', s: 3, main: true },
      { name: UPLOAD, s: 2 },
      ...teardown(false),
    ],
  },
  {
    name: 'coverage',
    afterChanges: true,
    steps: [
      ...setup(16),
      ...otelSetup,
      { name: 'Run mise run coverage', s: 170, main: true },
      { name: UPLOAD, s: 2 },
      { name: CODECOV, s: 4 },
      { name: CODECOV, s: 3 },
      ...teardown(false),
    ],
  },
  ...(['chromium', 'firefox', 'webkit'] as const).map((browser) =>
    e2e(`e2e (${browser})`, [
      {
        name: `Run mise run --skip-deps test:e2e --browser ${browser}`,
        s: browser === 'chromium' ? 130 : 95,
        main: true,
      },
      { name: UPLOAD, s: 0 },
    ]),
  ),
  {
    name: 'e2e-metrics-scale',
    afterChanges: true,
    steps: [
      containers,
      ...setup(16),
      { name: `Run ${CACHE}`, s: 1 },
      ...otelSetup,
      { name: 'Run mise run --skip-deps e2e:fixtures', s: 6 },
      {
        name: "Run pnpm exec playwright test e2e/scale.spec.ts --project chromium-perf-file --grep 'metrics scale' --workers=1",
        s: 55,
        main: true,
      },
      { name: UPLOAD, s: 0 },
      ...teardown(true),
      stopContainers,
    ],
  },
  {
    name: 'unit-os (windows-latest)',
    afterChanges: true,
    steps: [
      { name: `Run ${CHECKOUT}`, s: 7 },
      { name: 'Run ./.github/actions/setup', s: 49 },
      { name: `Run ${CACHE}`, s: 2 },
      { name: 'Build otel-html', s: 4 },
      { name: 'Run ./.github/actions/otel-html-setup', s: 1 },
      { name: 'Run mise run test:unit', s: 176, main: true },
      ...teardown(true),
    ],
  },
  binary('binary (ubuntu-latest, linux-x64)', 1),
  binary('binary (ubuntu-24.04-arm, linux-arm64)', 2),
  binary('binary (windows-latest, windows-x64, .exe)', 45),
];

const iso = (s: number): string => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

/** A job log line as the Actions log API writes it: a 7-digit fraction, then the message. */
const logLine = (s: number, n: number, message: string): string =>
  `${new Date(s * 1000).toISOString().slice(0, 19)}.${String(n).padStart(7, '0')}Z ${message}`;

type Built = { job: ApiJob; log: string };

function buildJob(
  rand: () => number,
  run: number,
  index: number,
  plan: JobPlan,
  createdAt: number,
  runId: number,
  event: string,
): Built {
  const id = runId * 100 + index;
  if (plan.name === PUSH_ONLY && event !== 'push') {
    const at = iso(createdAt);
    return {
      job: {
        id,
        name: plan.name,
        status: 'completed',
        runner_name: null,
        conclusion: 'skipped',
        created_at: at,
        started_at: at,
        completed_at: at,
        html_url: `${REPO_URL}/actions/runs/${runId}/job/${id}`,
        steps: [],
      },
      log: '',
    };
  }
  const queue = run === SLOW_QUEUE_RUN ? 30 + Math.round(rand() * 60) : 1 + Math.round(rand() * 3);
  const started = createdAt + queue;
  const fails = run === FAILED_RUN && plan.name === FAILING_JOB;
  const timesOut = run === TIMED_OUT_RUN && plan.name === TIMING_OUT_JOB;
  const steps: ApiStep[] = [];
  const log: string[] = [];
  let line = 0;
  const say = (s: number, message: string) => log.push(logLine(s, line++, message));

  let t = started;
  const add = (name: string, seconds: number, conclusion = 'success') => {
    steps.push({
      number: steps.length + 1,
      name,
      status: 'completed',
      conclusion,
      started_at: iso(t),
      completed_at: iso(t + seconds),
    });
    say(t, `##[group]${name}`);
    say(t, `##[endgroup]`);
    t += seconds;
  };

  add('Set up job', 1);
  let timedOut = false;
  for (const step of plan.steps) {
    // The work step varies most from run to run; the rest only a little.
    const jitter = step.main === true ? 0.8 + rand() * 0.5 : 0.85 + rand() * 0.35;
    const seconds = Math.round(step.s * jitter);
    // Past the timeout only the `if: always()` collect step and the post steps run; the rest are skipped.
    if (timedOut && !step.name.startsWith('Post ') && !step.name.includes('otel-html-collect')) {
      add(step.name, 0, 'skipped');
    } else if (timedOut) {
      add(step.name, seconds);
    } else if (step.main === true && timesOut) {
      timedOut = true;
      add(step.name, started + JOB_TIMEOUT_S - t, 'cancelled');
      say(
        t - 1,
        `##[error]The job running on runner GitHub Actions ${id} has exceeded the maximum execution time of 15 minutes.`,
      );
    } else if (step.main === true && fails) {
      add(step.name, Math.round(seconds * 0.6), 'failure');
      say(
        t - 3,
        '  1) [webkit] › e2e/traces.spec.ts:212:1 › the waterfall keeps its scroll position on a filter change',
      );
      say(t - 2, '##[error]Error: expect(locator).toBeInViewport() failed');
      say(t - 1, '##[error]Process completed with exit code 1.');
    } else {
      add(step.name, seconds);
      if (step.main === true && plan.name.startsWith('e2e (') && rand() < 0.25)
        say(t - 1, '##[warning]1 flaky test: e2e/metrics.spec.ts › the legend keeps a hidden series hidden');
    }
  }
  add('Complete job', 0);
  const conclusion = timesOut ? 'timed_out' : fails ? 'failure' : 'success';
  if (plan.name === 'unit-os (windows-latest)')
    say(t, '##[warning]The windows-latest label will move to windows-2025 on 2026-12-01.');

  return {
    job: {
      id,
      name: plan.name,
      status: 'completed',
      runner_name: `GitHub Actions ${1_000_002_000 + index}`,
      conclusion,
      created_at: iso(createdAt),
      started_at: iso(started),
      completed_at: iso(t),
      html_url: `${REPO_URL}/actions/runs/${runId}/job/${id}`,
      steps,
    },
    log: `${log.join('\n')}\n`,
  };
}

const EVENTS = ['push', 'push', 'pull_request', 'push', 'pull_request', 'schedule'] as const;

/** The OTLP/JSON requests of one run: its trace, each job's log records, and its metrics. */
function runRequests(rand: () => number, run: number, t0Seconds: number): object[] {
  const id = FIRST_RUN_ID + run * 1_731;
  const start = t0Seconds + run * RUN_EVERY_S;
  const event = EVENTS[run % EVENTS.length] ?? 'push';
  const built: Built[] = [];
  const changes = buildJob(rand, run, 0, JOBS[0] as JobPlan, start, id, event);
  const changesEnd = Date.parse(changes.job.completed_at ?? '') / 1000;
  built.push(changes);
  for (const [i, plan] of JOBS.entries()) {
    if (i === 0) continue;
    built.push(buildJob(rand, run, i, plan, plan.afterChanges ? changesEnd : start, id, event));
  }
  const jobs = built.map((b) => b.job);
  const end = Math.max(...jobs.map((j) => Date.parse(j.completed_at ?? '') / 1000)) + 2;
  const apiRun: ApiRun = {
    id,
    run_attempt: 1,
    name: 'ci',
    event,
    status: 'completed',
    conclusion: jobs.every((j) => j.conclusion === 'success' || j.conclusion === 'skipped')
      ? 'success'
      : 'failure',
    created_at: iso(start),
    run_started_at: iso(start),
    updated_at: iso(end),
    html_url: `${REPO_URL}/actions/runs/${id}`,
    head_branch: event === 'pull_request' ? `feat/demo-${run}` : 'main',
    head_sha: (id * 7919).toString(16).padStart(40, '0'),
    repository: { full_name: REPOSITORY, html_url: REPO_URL },
    head_repository: { full_name: REPOSITORY },
  };

  const key = runKey({ repository: REPOSITORY, runId: id, runAttempt: 1 });
  const none: ReadonlySet<number> = new Set();
  return [
    workflowTraceRequest(key, apiRun, jobs, none),
    // A skipped job has no log, so `ci report` adds no records for it.
    ...built
      .filter(({ log }) => log !== '')
      .map(({ job, log }) =>
        jobLogRecordsRequest({
          key,
          jobId: jobIdFor(job, none),
          job,
          text: log,
          resource: jobResource(apiRun, job),
        }),
      ),
    ciMetricsRequest(apiRun, jobs, ciResource(apiRun)),
  ];
}

/** fixtures/ci.otlp.json: `CI_RUNS` runs, three hours apart from `t0Seconds`, one request per line. */
export function buildCi(rand: () => number, t0Seconds: number): string {
  const lines: string[] = [];
  for (let run = 0; run < CI_RUNS; run++) {
    for (const request of runRequests(rand, run, t0Seconds)) lines.push(JSON.stringify(request));
  }
  return `${lines.join('\n')}\n`;
}

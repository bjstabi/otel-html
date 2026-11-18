// The made-up CI history behind fixtures/ci.otlp.json: runs of this repo's `ci` workflow, its job and step names,
// timings near a real run's, described as the Actions API returns them and turned into OTLP by the code `otel-html ci
// report` uses, so the data carries what a real CI report does. One OTLP/JSON request per line.
import type { ApiJob, ApiRun, ApiStep } from '../src/cli/ci/github-api.js';
import { type JobId, jobSpanIdOf, runKey, traceIdOf } from '../src/cli/ci/ids.js';
import { jobLogRecordsRequest } from '../src/cli/ci/job-logs.js';
import { ciMetricsRequest } from '../src/cli/ci/metrics.js';
import { attrs, ns } from '../src/cli/ci/otlp.js';
import { jobIdFor } from '../src/cli/ci/publish.js';
import { parseWorkflow } from '../src/cli/ci/workflow-file.js';
import {
  ciResource,
  jobResource,
  jobTraceRequest,
  workflowTraceRequest,
} from '../src/cli/ci/workflow-trace.js';

const REPOSITORY = 'example/otel-html';
const REPO_URL = `https://github.com/${REPOSITORY}`;
/** 40 runs over 10 days, one every 6 hours; the last is still running (a provisional root). */
export const CI_RUNS = 40;
const RUN_EVERY_S = 6 * 3600;
/** The run still going when the history ends: only its provisional root and the job that is running. */
export const IN_PROGRESS_RUN: number = CI_RUNS - 1;
/** The run that was re-run: attempt 1 fails at `FAILING_JOB`, attempt 2 (45 minutes later) passes. */
export const RERUN_ATTEMPT_AFTER_S: number = 45 * 60;
/** The run whose `CANCELLED_JOB` is cancelled; its conclusion is `cancelled`. */
export const CANCELLED_RUN = 20;
export const CANCELLED_JOB: string = 'e2e (firefox)';
/** The docs-only run: `changes` says so, and every job that `needs: changes` is skipped. */
export const DOCS_ONLY_RUN = 16;
/** The jobs whose mise tasks (and, under them, test cases) the fixture records. */
export const MISE_JOBS: readonly ['check', 'e2e (chromium)'] = ['check', 'e2e (chromium)'];
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

/** The workflow file text the job ids, `needs` and `if` come from; a cut-down copy of this repo's ci.yml. */
const WORKFLOW = `
jobs:
  changes: {}
  check: {}
  build: {}
  e2e:
    needs: changes
    if: \${{ !cancelled() && needs.changes.outputs.docs_only != 'true' }}
  e2e-metrics-scale:
    needs: changes
    if: \${{ !cancelled() && needs.changes.outputs.docs_only != 'true' }}
  unit-os:
    name: unit-os (\${{ matrix.os }})
    needs: changes
    if: \${{ !cancelled() && needs.changes.outputs.docs_only != 'true' }}
  binary:
    name: binary (\${{ matrix.os }}, \${{ matrix.target }}\${{ matrix.ext }})
    needs: changes
    if: \${{ !cancelled() && needs.changes.outputs.docs_only != 'true' }}
  coverage:
    needs: [changes, check]
    if: \${{ !cancelled() && needs.check.result == 'success' && github.event_name == 'push' }}
`;
const WORKFLOW_JOBS = parseWorkflow(WORKFLOW);
/** The two runner pools: GitHub's Linux pool (arm included, in this made-up history) and its Windows pool. */
const labelsOf = (job: string): string[] =>
  job.includes('windows') ? ['windows-latest'] : ['ubuntu-latest'];

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

/** `main` is the span of seconds the job's work step took, when it ran. */
type Built = { job: ApiJob; log: string; main?: { start: number; end: number } };

function buildJob(
  rand: () => number,
  run: number,
  index: number,
  plan: JobPlan,
  createdAt: number,
  runId: number,
  event: string,
  attempt: number,
): Built {
  const id = runId * 100 + index + (attempt - 1) * 50;
  const docsOnly = run === DOCS_ONLY_RUN && plan.afterChanges;
  if ((plan.name === PUSH_ONLY && event !== 'push') || docsOnly) {
    const at = iso(createdAt);
    return {
      job: {
        id,
        name: plan.name,
        status: 'completed',
        runner_name: null,
        labels: labelsOf(plan.name),
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
  const fails = run === FAILED_RUN && attempt === 1 && plan.name === FAILING_JOB;
  const timesOut = run === TIMED_OUT_RUN && plan.name === TIMING_OUT_JOB;
  const cancelled = run === CANCELLED_RUN && plan.name === CANCELLED_JOB;
  let main: Built['main'];
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
    } else if (step.main === true && cancelled) {
      // Someone cancelled the run part-way through the work step; the post steps still run.
      timedOut = true;
      main = { start: t, end: t + Math.round(seconds * 0.4) };
      add(step.name, Math.round(seconds * 0.4), 'cancelled');
    } else if (step.main === true && timesOut) {
      timedOut = true;
      add(step.name, started + JOB_TIMEOUT_S - t, 'cancelled');
      say(
        t - 1,
        `##[error]The job running on runner GitHub Actions ${id} has exceeded the maximum execution time of 15 minutes.`,
      );
    } else if (step.main === true && fails) {
      main = { start: t, end: t + Math.round(seconds * 0.6) };
      add(step.name, Math.round(seconds * 0.6), 'failure');
      say(
        t - 3,
        '  1) [webkit] › e2e/traces.spec.ts:212:1 › the waterfall keeps its scroll position on a filter change',
      );
      say(t - 2, '##[error]Error: expect(locator).toBeInViewport() failed');
      say(t - 1, '##[error]Process completed with exit code 1.');
    } else {
      if (step.main === true) main = { start: t, end: t + seconds };
      add(step.name, seconds);
      if (step.main === true && plan.name.startsWith('e2e (') && rand() < 0.25)
        say(t - 1, '##[warning]1 flaky test: e2e/metrics.spec.ts › the legend keeps a hidden series hidden');
    }
  }
  add('Complete job', 0);
  const conclusion = timesOut ? 'timed_out' : cancelled ? 'cancelled' : fails ? 'failure' : 'success';
  if (plan.name === 'unit-os (windows-latest)')
    say(t, '##[warning]The windows-latest label will move to windows-2025 on 2026-12-01.');

  return {
    job: {
      id,
      name: plan.name,
      status: 'completed',
      runner_name: `GitHub Actions ${1_000_002_000 + index}`,
      labels: labelsOf(plan.name),
      conclusion,
      created_at: iso(createdAt),
      started_at: iso(started),
      completed_at: iso(t),
      html_url: `${REPO_URL}/actions/runs/${runId}/job/${id}`,
      steps,
    },
    log: `${log.join('\n')}\n`,
    ...(main === undefined ? {} : { main }),
  };
}

const EVENTS = [
  'push',
  'push',
  'pull_request',
  'push',
  'pull_request',
  'schedule',
  'workflow_dispatch',
] as const;

/** A mise task of a job: its weight in the work step's time, and when a replayed (cached) run skips it. */
type MiseTask = {
  name: string;
  weight: number;
  skipped?: (run: number) => boolean;
  tests?: 'vitest' | 'playwright';
};
const MISE_TASKS: Readonly<Record<(typeof MISE_JOBS)[number], MiseTask[]>> = {
  check: [
    { name: 'lint', weight: 8, skipped: (run) => run % 2 === 0 },
    { name: 'typecheck', weight: 12, skipped: (run) => run % 2 === 0 },
    { name: 'knip', weight: 7, skipped: (run) => run % 2 === 0 },
    { name: 'scaling:reports', weight: 10, skipped: (run) => run % 4 !== 1 },
    { name: 'test:unit:main', weight: 55, tests: 'vitest' },
  ],
  'e2e (chromium)': [
    { name: 'e2e:fixtures', weight: 10, skipped: (run) => run % 3 === 0 },
    { name: 'test:e2e', weight: 90, tests: 'playwright' },
  ],
};

const VITEST_FILES = [
  'test/model/anyvalue.test.ts',
  'test/format/manifest.test.ts',
  'test/writer/cicd-rows.test.ts',
  'test/query/sql/views.test.ts',
  'test/viewer/cicd/derive.test.ts',
] as const;
const PLAYWRIGHT_FILES = ['e2e/traces.spec.ts', 'e2e/metrics.spec.ts', 'e2e/dashboards.spec.ts'] as const;
const TESTS_PER_FILE = 4;

type TestCase = {
  file: string;
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | number | boolean | string[]>;
};

/**
 * The test cases of one test task, laid end to end across `[start, end]` (ms). Vitest: 20 tests, one `skip` and one
 * `todo`. Playwright: 12 tests, one skipped, and one that failed once and passed on its retry.
 */
function testCases(
  kind: 'vitest' | 'playwright',
  rand: () => number,
  start: number,
  end: number,
): TestCase[] {
  const files = kind === 'vitest' ? VITEST_FILES : PLAYWRIGHT_FILES;
  const slots = files.length * TESTS_PER_FILE + (kind === 'playwright' ? 1 : 0);
  const slice = Math.max(1, Math.floor((end - start) / slots));
  const cases: TestCase[] = [];
  let at = start;
  let n = 0;
  for (const file of files) {
    for (let k = 0; k < TESTS_PER_FILE; k++, n++) {
      const title = `${file.split('/').at(-1)?.split('.')[0]} case ${k + 1}`;
      const skipped = n === 1 || n === 6;
      const take = skipped ? 0 : Math.round(slice * (0.4 + rand() * 0.55));
      const base = { file, name: title, startMs: at, endMs: at + take };
      if (kind === 'vitest') {
        const mode = n === 1 ? 'skip' : n === 6 ? 'todo' : 'run';
        cases.push({
          ...base,
          attributes: { 'test.suite.name': file, 'vitest.test.name': title, 'vitest.test.mode': mode },
        });
      } else {
        const common = {
          'test.suite.name': file,
          'test.case.name': `${file} > ${title}`,
          'playwright.project': 'chromium',
          'otel_html.test.tags': [] as string[],
        };
        if (n === 5) {
          // Failed once, passed on retry 1.
          cases.push({
            ...base,
            attributes: { ...common, 'otel_html.test.retry': 0, 'test.case.result.status': 'fail' },
          });
          at += take;
          cases.push({
            ...base,
            startMs: at,
            endMs: at + take,
            attributes: { ...common, 'otel_html.test.retry': 1, 'test.case.result.status': 'pass' },
          });
        } else {
          cases.push({
            ...base,
            attributes: {
              ...common,
              'otel_html.test.retry': 0,
              'test.case.result.status': n === 9 ? 'skipped' : 'pass',
            },
          });
        }
      }
      at += take;
    }
  }
  return cases;
}

const span = (
  traceId: string,
  spanId: string,
  parentSpanId: string,
  name: string,
  startMs: number,
  endMs: number,
  attributes: Record<string, string | number | boolean | string[]>,
  failed = false,
) => ({
  traceId,
  spanId,
  parentSpanId,
  name,
  kind: 1,
  startTimeUnixNano: ns(startMs),
  endTimeUnixNano: ns(Math.max(startMs, endMs)),
  attributes: attrs(attributes),
  ...(failed ? { status: { code: 2, message: 'failed' } } : {}),
});

/**
 * What the job's steps record under it in a real run: the `mise.tasks` spans of the work step (`mise.task.skipped`
 * is written only as `true`, for a replayed task; a task that ran has none), and under the test task the vitest or
 * Playwright test spans. All share the run's trace; only the mise resource carries `cicd.pipeline.*`.
 */
function miseRequest(
  rand: () => number,
  key: string,
  run: number,
  event: string,
  runId: number,
  built: Built,
  jobId: JobId,
): object | undefined {
  const plan = MISE_TASKS[built.job.name as (typeof MISE_JOBS)[number]];
  if (plan === undefined || built.main === undefined || built.job.conclusion !== 'success') return undefined;
  const traceId = traceIdOf(key);
  const jobSpanId = jobSpanIdOf(key, jobId);
  const replayed = (t: MiseTask) => event !== 'schedule' && t.skipped?.(run) === true;
  const weights = plan.map((t) => (replayed(t) ? 0.3 : t.weight));
  const total = weights.reduce((a, b) => a + b, 0);
  const winStart = built.main.start * 1000;
  const winLen = (built.main.end - built.main.start) * 1000;
  const miseSpans: object[] = [];
  const vitestSpans: object[] = [];
  const playwrightSpans: object[] = [];
  let at = winStart;
  for (const [i, task] of plan.entries()) {
    const end = at + Math.round(((weights[i] ?? 0) / total) * winLen);
    const taskSpanId = jobSpanIdOf(key, `${jobId}#mise:${task.name}`);
    miseSpans.push(
      span(traceId, taskSpanId, jobSpanId, task.name, at, end, {
        'mise.task.name': task.name,
        'mise.task.display_name': task.name,
        'mise.task.source': 'mise.toml',
        'process.exit.code': 0,
        ...(replayed(task) ? { 'mise.task.skipped': true } : {}),
      }),
    );
    if (task.tests !== undefined) {
      const out = task.tests === 'vitest' ? vitestSpans : playwrightSpans;
      for (const [k, c] of testCases(task.tests, rand, at, end).entries()) {
        const failed = c.attributes['test.case.result.status'] === 'fail';
        out.push(
          span(
            traceId,
            jobSpanIdOf(key, `${jobId}#test:${task.name}:${k}`),
            taskSpanId,
            c.name,
            c.startMs,
            c.endMs,
            c.attributes,
            failed,
          ),
        );
      }
    }
    at = end;
  }
  const group = (resource: Record<string, string>, scope: string, spans: object[]) =>
    spans.length === 0
      ? []
      : [{ resource: { attributes: attrs(resource) }, scopeSpans: [{ scope: { name: scope }, spans }] }];
  const testResource = (framework: string) => ({
    'service.name': 'otel-html-tests',
    'service.version': '0.7.0',
    'test.framework': framework,
  });
  return {
    resourceSpans: [
      ...group(
        {
          'service.name': `ci/${built.job.name}`,
          'cicd.pipeline.name': 'ci',
          'cicd.pipeline.run.id': String(runId),
          'cicd.pipeline.task.name': built.job.name,
        },
        'mise.tasks',
        miseSpans,
      ),
      ...group(testResource('vitest'), 'vitest', vitestSpans),
      ...group(testResource('playwright'), 'otel-html-tests', playwrightSpans),
    ],
  };
}

/** The OTLP/JSON requests of one run attempt: its trace, the mise and test spans, each job's log records, and its metrics. */
function attemptRequests(rand: () => number, run: number, start: number, attempt: number): object[] {
  const id = FIRST_RUN_ID + run * 1_731;
  const event = EVENTS[run % EVENTS.length] ?? 'push';
  const built: Built[] = [];
  const changes = buildJob(rand, run, 0, JOBS[0] as JobPlan, start, id, event, attempt);
  const changesEnd = Date.parse(changes.job.completed_at ?? '') / 1000;
  built.push(changes);
  for (const [i, plan] of JOBS.entries()) {
    if (i === 0) continue;
    built.push(buildJob(rand, run, i, plan, plan.afterChanges ? changesEnd : start, id, event, attempt));
  }
  const jobs = built.map((b) => b.job);
  const end = Math.max(...jobs.map((j) => Date.parse(j.completed_at ?? '') / 1000)) + 2;
  const conclusion =
    run === CANCELLED_RUN
      ? 'cancelled'
      : jobs.every((j) => j.conclusion === 'success' || j.conclusion === 'skipped')
        ? 'success'
        : 'failure';
  const apiRun: ApiRun = {
    id,
    run_attempt: attempt,
    name: 'ci',
    event,
    display_title: run === DOCS_ONLY_RUN ? 'docs: fix a typo in the README' : `demo run ${run}`,
    status: 'completed',
    conclusion,
    created_at: iso(start),
    run_started_at: iso(start),
    updated_at: iso(end),
    html_url: `${REPO_URL}/actions/runs/${id}`,
    path: '.github/workflows/ci.yml',
    actor: { type: 'User' },
    head_branch: event === 'pull_request' ? `feat/demo-${run}` : 'main',
    head_sha: (id * 7919).toString(16).padStart(40, '0'),
    repository: { full_name: REPOSITORY, html_url: REPO_URL },
    head_repository: { full_name: REPOSITORY },
  };

  const key = runKey({ repository: REPOSITORY, runId: id, runAttempt: attempt });
  const none: ReadonlyMap<number, JobId> = new Map();
  const mise = built.flatMap((b) => {
    const r = miseRequest(rand, key, run, event, id, b, jobIdFor(b.job, none));
    return r === undefined ? [] : [r];
  });
  return [
    workflowTraceRequest(key, apiRun, jobs, none, WORKFLOW_JOBS),
    ...mise,
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

/** The run still going: the provisional root and the `check` job part-way through its steps (§5.5). */
function inProgressRequests(rand: () => number, run: number, start: number): object[] {
  const id = FIRST_RUN_ID + run * 1_731;
  const event = EVENTS[run % EVENTS.length] ?? 'push';
  const check = buildJob(rand, run, 1, JOBS[1] as JobPlan, start, id, event, 1).job;
  const now = Date.parse(check.started_at ?? '') + 100_000;
  const job: ApiJob = {
    ...check,
    status: 'in_progress',
    conclusion: null,
    completed_at: null,
    steps: check.steps
      .filter((s) => Date.parse(s.started_at ?? '') <= now)
      .map((s) =>
        Date.parse(s.completed_at ?? '') <= now
          ? s
          : { ...s, status: 'in_progress', conclusion: null, completed_at: null },
      ),
  };
  const apiRun: ApiRun = {
    id,
    run_attempt: 1,
    name: 'ci',
    event,
    display_title: `demo run ${run}`,
    status: 'in_progress',
    conclusion: null,
    created_at: iso(start),
    run_started_at: iso(start),
    updated_at: iso(now / 1000),
    html_url: `${REPO_URL}/actions/runs/${id}`,
    path: '.github/workflows/ci.yml',
    actor: { type: 'User' },
    head_branch: event === 'pull_request' ? `feat/demo-${run}` : 'main',
    head_sha: (id * 7919).toString(16).padStart(40, '0'),
    repository: { full_name: REPOSITORY, html_url: REPO_URL },
    head_repository: { full_name: REPOSITORY },
  };
  const key = runKey({ repository: REPOSITORY, runId: id, runAttempt: 1 });
  return [jobTraceRequest(key, apiRun, job, now, new Map())];
}

function runRequests(rand: () => number, run: number, t0Seconds: number): object[] {
  const start = t0Seconds + run * RUN_EVERY_S;
  if (run === IN_PROGRESS_RUN) return inProgressRequests(rand, run, start);
  return [
    ...attemptRequests(rand, run, start, 1),
    ...(run === FAILED_RUN ? attemptRequests(rand, run, start + RERUN_ATTEMPT_AFTER_S, 2) : []),
  ];
}

/** fixtures/ci.otlp.json: `CI_RUNS` runs, six hours apart from `t0Seconds`, one request per line. */
export function buildCi(rand: () => number, t0Seconds: number): string {
  const lines: string[] = [];
  for (let run = 0; run < CI_RUNS; run++) {
    for (const request of runRequests(rand, run, t0Seconds)) lines.push(JSON.stringify(request));
  }
  return `${lines.join('\n')}\n`;
}

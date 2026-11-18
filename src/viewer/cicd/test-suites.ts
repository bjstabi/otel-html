import type { AnyValue } from '../../model/anyvalue.js';
import type { TraceDetail } from '../data/data-source.js';
import type { TraceNode } from '../data/trace-tree.js';

interface SuiteTest {
  name: string;
  ms: number;
  skipped: boolean;
  project: string | null;
}
export interface SuiteFile {
  file: string;
  ms: number;
  tests: SuiteTest[];
  skipped: number;
}
export interface TestSuite {
  id: string;
  job: string;
  task: string;
  framework: 'vitest' | 'playwright';
  /** Sorted by test time, longest first. */
  files: SuiteFile[];
  total: number;
  skipped: number;
}

const JOB = 'cicd.pipeline.task.name';
const TASK = 'mise.task.name';
const VITEST_MODE = 'vitest.test.mode';
const PW_STATUS = 'test.case.result.status';
const RETRY = 'otel_html.test.retry';
const MAX_DEPTH = 64;

const str = (v: AnyValue | undefined): string | null => (v?.kind === 'string' ? v.value : null);
const num = (v: AnyValue | undefined): number =>
  v?.kind === 'int' ? Number(v.value) : v?.kind === 'double' ? v.value : 0;

/**
 * The test spans of a trace as suites, one per (job, mise task). A test span is attributed by walking its ancestors
 * within the trace, never by its own resource, which carries no `cicd.pipeline.*`: the task is the nearest ancestor
 * with `mise.task.name`, the job the nearest ancestor span with `cicd.pipeline.task.name`, else that task span's
 * resource. A Playwright test that was retried counts once (its last attempt, the time of all of them).
 */
export function testSuites(trace: Pick<TraceDetail, 'spans' | 'tree' | 'resources'>): TestSuite[] {
  const byId = trace.tree.byId;
  const parentOf = (n: TraceNode): TraceNode | undefined => {
    const pid = n.row.span.parentSpanId;
    return pid === null ? undefined : byId.get(pid);
  };
  const suites = new Map<string, TestSuite & { seen: Map<string, { test: SuiteTest; retry: number }> }>();
  for (const row of trace.spans) {
    const a = row.span.attributes;
    const mode = str(a.get(VITEST_MODE));
    const status = str(a.get(PW_STATUS));
    if (mode === null && status === null) continue;
    let task: TraceNode | undefined;
    let job: string | null = null;
    let up = byId.get(row.span.spanId);
    for (let depth = 0; up !== undefined && depth < MAX_DEPTH; depth++, up = parentOf(up)) {
      if (task === undefined) {
        const t = str(up.row.span.attributes.get(TASK));
        if (t !== null) task = up;
      }
      const j = str(up.row.span.attributes.get(JOB));
      if (j !== null && job === null) job = j;
      if (task !== undefined && job !== null) break;
    }
    if (task === undefined) continue;
    const taskName = str(task.row.span.attributes.get(TASK)) ?? '';
    job ??= str(trace.resources(task.row.span.resource).attributes.get(JOB)) ?? '';
    const id = `${job} › ${taskName}`;
    const suite = suites.get(id) ?? {
      id,
      job,
      task: taskName,
      framework: mode === null ? ('playwright' as const) : ('vitest' as const),
      files: [] as SuiteFile[],
      total: 0,
      skipped: 0,
      seen: new Map(),
    };
    suites.set(id, suite);
    const file = str(a.get('test.suite.name')) ?? '(no file)';
    const name = str(a.get('vitest.test.name')) ?? str(a.get('test.case.name')) ?? row.span.name;
    const project = str(a.get('playwright.project'));
    const ms = row.durationNs / 1e6;
    const key = `${file}\u0000${name}\u0000${project ?? ''}`;
    const retry = num(a.get(RETRY));
    const skipped = mode === 'skip' || mode === 'todo' || status === 'skipped';
    const prior = suite.seen.get(key);
    if (prior !== undefined) {
      prior.test.ms += ms;
      if (retry >= prior.retry) {
        prior.retry = retry;
        prior.test.skipped = skipped;
      }
      continue;
    }
    const test: SuiteTest = { name, ms, skipped, project };
    suite.seen.set(key, { test, retry });
    let f = suite.files.find((x) => x.file === file);
    if (f === undefined) {
      f = { file, ms: 0, tests: [], skipped: 0 };
      suite.files.push(f);
    }
    f.tests.push(test);
  }
  return [...suites.values()]
    .map(({ seen: _seen, ...s }) => {
      for (const f of s.files) {
        f.ms = f.tests.reduce((t, x) => t + x.ms, 0);
        f.skipped = f.tests.filter((t) => t.skipped).length;
        f.tests.sort((a, b) => b.ms - a.ms || (a.name < b.name ? -1 : 1));
      }
      s.files.sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : 1));
      s.total = s.files.reduce((t, f) => t + f.tests.length, 0);
      s.skipped = s.files.reduce((t, f) => t + f.skipped, 0);
      return s;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

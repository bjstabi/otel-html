import { attributesFromJson } from '../format/columns.js';
import type { ColumnBatch } from '../format/parquet/batch.js';
import { encodeTable } from '../format/parquet/codec.js';
import type { Row } from '../format/parquet/rows.js';
import type { AnyValue, Attributes } from '../model/anyvalue.js';

// The CI semantic conventions this file may know (see AGENTS.md: only here and the CI modules do).
const RUN_ID = 'cicd.pipeline.run.id';
const TASK_RUN_ID = 'cicd.pipeline.task.run.id';
const TASK_NAME = 'cicd.pipeline.task.name';
const STEP_NUMBER = 'github.job.step.number';
const PROVISIONAL = 'otel_html.ci.provisional';
const MISE_SCOPE = 'mise.tasks';
const MISE_SKIPPED = 'mise.task.skipped';
const STATUS_ERROR = 2;

const column = (b: ColumnBatch, name: string): readonly unknown[] => b.cells[name] ?? [];
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function text(attrs: Attributes, key: string): string | null {
  const v = attrs.get(key);
  return v?.kind === 'string' ? v.value : null;
}

function count(v: AnyValue | undefined): number | null {
  if (v === undefined) return null;
  if (v.kind === 'int') return Number(v.value);
  if (v.kind === 'string' && /^\d+$/.test(v.value)) return Number(v.value);
  return null;
}

/** A child of a job that can name its failed step. */
interface Step {
  readonly number: number | null;
  readonly start: bigint;
  readonly name: string;
  readonly failure: boolean;
  readonly error: boolean;
}

interface Tasks {
  start: bigint;
  end: bigint;
  replayed: number;
  run: number;
}

/**
 * The `cicd` rows of a partition's spans: a `run` row per workflow root, a `job` row per job span and a `tasks` row
 * per trace holding `mise.tasks` spans. `add` takes the spans chunk by chunk; the children of a job (its `queued`
 * span and steps) may arrive after the job, so they are joined in `rows()`.
 */
export class CicdRowSet {
  readonly #runs = new Map<string, { end: bigint; row: Row }>();
  readonly #jobs = new Map<string, { end: bigint; row: Row }>();
  readonly #queued = new Map<string, bigint>();
  readonly #steps = new Map<string, Step[]>();
  readonly #tasks = new Map<string, Tasks>();

  /** The number of rows `rows()` gives. */
  get size(): number {
    return this.#runs.size + this.#jobs.size + this.#tasks.size;
  }

  add(batch: ColumnBatch): void {
    const resources = new Map<string, Attributes>();
    const resourceOf = (text: unknown): Attributes => {
      const key = typeof text === 'string' ? text : '{}';
      let v = resources.get(key);
      if (v === undefined) {
        v = attributesFromJson(key);
        resources.set(key, v);
      }
      return v;
    };
    const traces = column(batch, 'trace_id');
    const ids = column(batch, 'span_id');
    const parents = column(batch, 'parent_span_id');
    const names = column(batch, 'name');
    const starts = column(batch, 'start_time_unix_nano');
    const ends = column(batch, 'end_time_unix_nano');
    const statuses = column(batch, 'status_code');
    const attrTexts = column(batch, 'attributes');
    const resTexts = column(batch, 'resource_attributes');
    const scopes = column(batch, 'scope_name');

    for (let i = 0; i < batch.length; i++) {
      const trace = traces[i];
      const id = ids[i];
      const start = starts[i];
      const end = ends[i];
      if (typeof trace !== 'string' || typeof id !== 'string') continue;
      if (typeof start !== 'bigint' || typeof end !== 'bigint') continue;
      const name = typeof names[i] === 'string' ? (names[i] as string) : '';
      const parent = typeof parents[i] === 'string' && parents[i] !== '' ? (parents[i] as string) : null;
      const attrText = typeof attrTexts[i] === 'string' ? (attrTexts[i] as string) : '{}';

      if (scopes[i] === MISE_SCOPE) {
        const skipped = attrText.includes(MISE_SKIPPED)
          ? attributesFromJson(attrText).get(MISE_SKIPPED)
          : undefined;
        const t = this.#tasks.get(trace) ?? { start, end, replayed: 0, run: 0 };
        if (start < t.start) t.start = start;
        if (end > t.end) t.end = end;
        if (skipped?.kind === 'bool' && skipped.value) t.replayed++;
        else t.run++;
        this.#tasks.set(trace, t);
        continue;
      }

      // Only spans that can be CI records are decoded: the others' attribute text names none of the keys.
      const isStep = attrText.includes(STEP_NUMBER);
      const maybeCi =
        attrText.includes(TASK_RUN_ID) || attrText.includes('github.') || attrText.includes(PROVISIONAL);
      const candidateRoot = parent === null && typeof resTexts[i] === 'string' && resTexts[i] !== '{}';
      if (!maybeCi && !candidateRoot && name !== 'queued' && !isStep) continue;

      const attrs = attributesFromJson(attrText);
      const provisional = attrs.get(PROVISIONAL);
      if (provisional?.kind === 'bool' && provisional.value) continue;

      if (parent !== null && name === 'queued' && attrs.has(TASK_NAME) && !attrs.has(TASK_RUN_ID)) {
        const d = end > start ? end - start : 0n;
        this.#queued.set(`${trace}/${parent}`, d);
      }
      if (parent !== null && (isStep || attrs.has(STEP_NUMBER))) {
        const result = text(attrs, 'cicd.pipeline.task.step.result');
        const key = `${trace}/${parent}`;
        const step: Step = {
          number: count(attrs.get(STEP_NUMBER)),
          start,
          name,
          failure: result === 'failure',
          error: statuses[i] === STATUS_ERROR,
        };
        if (step.failure || step.error) {
          const list = this.#steps.get(key) ?? [];
          list.push(step);
          this.#steps.set(key, list);
        }
      }

      const resource = resourceOf(resTexts[i]);
      if (parent === null && resource.has(RUN_ID)) {
        const prior = this.#runs.get(trace);
        if (prior === undefined || end > prior.end) {
          this.#runs.set(trace, {
            end,
            row: {
              kind: 'run',
              trace_id: trace,
              span_id: id,
              start_ns: start,
              end_ns: end,
              name,
              result: text(attrs, 'cicd.pipeline.result'),
              pipeline: text(resource, 'cicd.pipeline.name'),
              run_id: text(resource, RUN_ID),
              attempt: count(attrs.get('github.run_attempt')),
              trigger: text(resource, 'cicd.pipeline.trigger') ?? text(attrs, 'github.event'),
              branch: text(resource, 'vcs.ref.head.name'),
              revision: text(resource, 'vcs.ref.head.revision'),
              title: text(resource, 'vcs.ref.head.title'),
            },
          });
        }
      }
      if (attrs.has(TASK_RUN_ID) && attrs.has(TASK_NAME)) {
        const key = `${trace}/${id}`;
        const prior = this.#jobs.get(key);
        if (prior === undefined || end > prior.end) {
          const needs = attrs.get('cicd.pipeline.task.needs');
          this.#jobs.set(key, {
            end,
            row: {
              kind: 'job',
              trace_id: trace,
              span_id: id,
              start_ns: start,
              end_ns: end,
              name,
              result: text(attrs, 'cicd.pipeline.task.run.result'),
              task: text(attrs, TASK_NAME),
              task_id: text(attrs, 'cicd.pipeline.task.id'),
              labels: text(resource, 'cicd.worker.labels'),
              needs:
                needs?.kind === 'array' && needs.values.length > 0
                  ? JSON.stringify(needs.values.map(plain))
                  : null,
              condition: text(attrs, 'cicd.pipeline.task.condition'),
            },
          });
        }
      }
    }
  }

  /** The rows, sorted by trace id, kind and start; the jobs carry their `queued_ns` and `failed_step`. */
  rows(): Row[] {
    const out: Row[] = [];
    for (const { row } of this.#runs.values()) out.push(row);
    for (const [key, { row }] of this.#jobs) {
      const steps = [...(this.#steps.get(key) ?? [])].sort(
        (a, b) =>
          (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) ||
          (a.start < b.start ? -1 : a.start > b.start ? 1 : 0),
      );
      const failed = steps.find((s) => s.failure) ?? steps.find((s) => s.error);
      out.push({ ...row, queued_ns: this.#queued.get(key) ?? null, failed_step: failed?.name ?? null });
    }
    for (const [trace, t] of this.#tasks) {
      out.push({
        kind: 'tasks',
        trace_id: trace,
        start_ns: t.start,
        end_ns: t.end,
        tasks_replayed: t.replayed,
        tasks_run: t.run,
      });
    }
    const big = (r: Row): bigint => {
      const v = Reflect.get(r, 'start_ns');
      return typeof v === 'bigint' ? v : 0n;
    };
    const s = (r: Row, k: string): string => {
      const v = Reflect.get(r, k);
      return typeof v === 'string' ? v : '';
    };
    return out.sort(
      (a, b) =>
        cmp(s(a, 'trace_id'), s(b, 'trace_id')) ||
        cmp(s(a, 'kind'), s(b, 'kind')) ||
        (big(a) < big(b) ? -1 : big(a) > big(b) ? 1 : 0) ||
        cmp(s(a, 'span_id'), s(b, 'span_id')),
    );
  }
}

function plain(v: AnyValue): unknown {
  return v.kind === 'string' ? v.value : v.kind === 'int' ? Number(v.value) : null;
}

/** The `cicd.parquet` bytes of `rows` (sorted by trace id, kind and start). */
export function encodeCicd(rows: readonly Row[], rowGroupRows: number): Uint8Array {
  return encodeTable('cicd', rows, { rowGroupRows });
}

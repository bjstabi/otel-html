import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadConfigFile } from '../../src/config/load.js';
import { resolveConfig } from '../../src/config/resolve.js';
import type { ResolvedConfig } from '../../src/config/schema.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import type { JsonObject } from '../../test-support/otlp-builders.js';
import { otlp } from '../../test-support/writer-deps.js';
import { spanIdOf, traceIdOf } from './helpers.js';

const CI_YAML = 'test-support/legacy-ci.otel-html.yaml';
export const T0 = 1_700_000_000_000_000_000n;

export async function ciConfig(): Promise<ResolvedConfig> {
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/c');
  await fs.writeTextAtomic('/c/ci.yaml', await readFile(CI_YAML, 'utf8'));
  return resolveConfig({ file: await loadConfigFile(fs, '/c/ci.yaml'), env: {}, fileLabel: 'config.yaml' })
    .config;
}

const str = (key: string, value: string): JsonObject => ({ key, value: { stringValue: value } });

export interface CiSpan {
  i: number;
  /** A root span has no parent; a job span has one and its job attributes. */
  job?: 'success' | 'skip';
  scope?: string;
  run?: string;
  task?: string;
  /** An int-valued `cicd.pipeline.task.name`. */
  taskInt?: number;
  start?: bigint;
  end?: bigint;
  trace?: number;
  /** An extra attribute, for weight. */
  pad?: string;
}

/** One request holding each span in a resource of its own, as the CI publisher writes a run. */
export function ciRequest(spans: readonly CiSpan[]): ReturnType<typeof otlp> {
  return otlp({
    resourceSpans: spans.map((s) => ({
      resource: {
        attributes: [
          str('cicd.pipeline.name', 'ci'),
          str('cicd.pipeline.run.id', s.run ?? '7'),
          ...(s.task === undefined ? [] : [str('cicd.pipeline.task.name', s.task)]),
          ...(s.taskInt === undefined
            ? []
            : [{ key: 'cicd.pipeline.task.name', value: { intValue: String(s.taskInt) } }]),
        ],
      },
      scopeSpans: [
        {
          scope: { name: s.scope ?? 'otel-html-ci' },
          spans: [
            {
              traceId: traceIdOf(s.trace ?? 0),
              spanId: spanIdOf(s.i),
              ...(s.job === undefined ? {} : { parentSpanId: spanIdOf(1000) }),
              name: 'n',
              kind: 1,
              startTimeUnixNano: String(s.start ?? T0 + BigInt(s.i)),
              endTimeUnixNano: String(s.end ?? T0 + BigInt(s.i) + 5n),
              attributes: [
                ...(s.job === undefined
                  ? []
                  : [
                      str('cicd.pipeline.task.run.id', String(s.i)),
                      str('cicd.pipeline.task.run.result', s.job),
                    ]),
                ...(s.pad === undefined ? [] : [str('pad', s.pad)]),
              ],
            },
          ],
        },
      ],
    })),
  });
}
const noise = (i: number): string =>
  [0, 1, 2].map((k) => createHash('sha256').update(`${i}:${k}`).digest('hex')).join('');

/** Spans of another scope: they give the spans file the weight a real partition has, and match no widget. */
export const filler = (n: number, from = 100): CiSpan[] =>
  Array.from({ length: n }, (_, k) => ({
    i: from + k,
    trace: from + k,
    scope: 'other',
    run: `filler-${from + k}`,
    pad: noise(from + k),
  }));

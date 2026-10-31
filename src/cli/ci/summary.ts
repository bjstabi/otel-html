import type { ApiJob, ApiRun } from './github-api.js';
import { seconds } from './otlp.js';

/** `12s`, `1m 23s`, `4m 05s`, `1h 02m 03s`. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${two(m)}m ${two(sec)}s`;
  if (m > 0) return `${m}m ${two(sec)}s`;
  return `${sec}s`;
}

const secondsBetween = (from: string | null, to: string | null): string => {
  const s = seconds(from, to);
  return s === undefined ? '–' : formatDuration(s);
};

/** First line of the sticky pull request comment; `ci link` finds its own comment by it. */
export const MARKER = '<!-- otel-html-report -->';

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** GitHub-flavoured markdown for `$GITHUB_STEP_SUMMARY`: the run's outcome, one row per job, and where the report is. */
export function summaryTable(run: ApiRun, jobs: ApiJob[], reportUrl: string | null): string {
  const rows = jobs.map(
    (j) =>
      `| ${cell(j.name)} | ${j.conclusion ?? j.status} | ${secondsBetween(j.created_at, j.started_at)} | ${secondsBetween(j.started_at, j.completed_at)} |`,
  );
  return [
    `## ${cell(run.name)}: ${run.conclusion ?? run.status} ([run ${run.id}](${run.html_url}))`,
    '',
    '| Job | Result | Queued | Duration |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    reportUrl === null ? 'Report: see the `ci-run-report` artifact' : `Report: ${reportUrl}`,
    '',
  ].join('\n');
}

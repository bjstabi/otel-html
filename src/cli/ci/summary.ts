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

/** Prefix of the sticky pull request comment's first line, `<!-- otel-html-report:<workflow> -->`. */
export const MARKER = '<!-- otel-html-report';

/**
 * `text` as a markdown code span, so a name cannot mention, link or embed: the delimiter is one backtick longer than
 * the longest run inside, and a space pads a text that starts or ends with a backtick. The empty string stays empty.
 */
export function codeSpan(text: string): string {
  if (text === '') return '';
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const cell = (s: string): string => codeSpan(s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));

/** GitHub-flavoured markdown for `$GITHUB_STEP_SUMMARY`: the run's outcome and one row per job. */
export function summaryTable(run: ApiRun, jobs: ApiJob[]): string {
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
  ].join('\n');
}

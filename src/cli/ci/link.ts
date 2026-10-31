import type { ApiJob, ApiRun } from './github-api.js';
import type { SiteIndex, SiteRun } from './site.js';
import { MARKER, summaryTable } from './summary.js';

/** The pure side of `ci link`: the sticky pull request comment and the check run that point at a run's report. */

export { MARKER };

export type PreviousRun = { url: string; runId: number };

/** The sticky comment: `MARKER`, the run's summary table and, when there is one, a link to the run before it. */
export function commentBody(
  run: ApiRun,
  jobs: ApiJob[],
  url: string,
  previous: PreviousRun | undefined,
): string {
  const lines = [MARKER, summaryTable(run, jobs, url)];
  if (previous !== undefined) lines.push(`Previous run: [run ${previous.runId}](${previous.url})`, '');
  return lines.join('\n');
}

/** The id of the comment that carries `MARKER`, if any. */
export const findStickyComment = (comments: { id: number; body: string }[]): number | undefined =>
  comments.find((c) => c.body.includes(MARKER))?.id;

export function checkRunPayload(
  run: ApiRun,
  url: string,
): {
  name: 'otel-html report';
  head_sha: string;
  status: 'completed';
  conclusion: 'neutral';
  details_url: string;
  output: { title: string; summary: string };
} {
  return {
    name: 'otel-html report',
    head_sha: run.head_sha,
    status: 'completed',
    conclusion: 'neutral',
    details_url: url,
    output: { title: `Report for run ${run.id}`, summary: `Report: ${url}` },
  };
}

/**
 * The run listed right after `runId` in its channel (the one before it in time) and the URL of its report, derived
 * from this run's report `url` by swapping the report paths. Undefined when the run is not on the site, is the oldest
 * in its channel, or `url` does not end in this run's report path.
 */
export function previousRun(index: SiteIndex, runId: number, url: string): PreviousRun | undefined {
  for (const channel of Object.values(index.channels)) {
    const at = channel.runs.findIndex((r) => r.runId === runId);
    if (at < 0) continue;
    const mine = channel.runs[at] as SiteRun;
    const prev = channel.runs[at + 1];
    const tail = `/${mine.reportPath}/`;
    if (prev === undefined || !url.endsWith(tail)) return undefined;
    return { runId: prev.runId, url: `${url.slice(0, -tail.length)}/${prev.reportPath}/` };
  }
  return undefined;
}

import { type ApiJob, type ApiRun, CHECK_RUN_NAME } from './github-api.js';
import { type Channel, type SiteIndex, type SiteRun, slug } from './site.js';
import { MARKER, summaryTable } from './summary.js';

/** The pure side of `ci link`: the sticky pull request comment and the check run that point at a run's report. */

export { MARKER };

const markerOf = (workflow: string): string => `${MARKER}:${workflow} -->`;
/** The marker before comments were per workflow; those comments belong to the `ci` workflow. */
const LEGACY_MARKER = `${MARKER} -->`;

export type PreviousRun = { url: string; runId: number; workflow?: string };
/**
 * A channel's rolling report, every retained run of every workflow: `label` is what the runs are on, `this pull
 * request` or the branch as a code span.
 */
export type ChannelPage = { label: string; url: string };

/**
 * The sticky comment: `MARKER`, the run's summary table, then, when there are, a link to the channel's rolling report
 * and to the run before this one (labelled with its workflow when the site knows it).
 */
export function commentBody(
  run: ApiRun,
  jobs: ApiJob[],
  url: string,
  previous: PreviousRun | undefined,
  page?: ChannelPage,
): string {
  const lines = [markerOf(slug(run.name)), summaryTable(run, jobs, url)];
  if (page !== undefined) lines.push(`All runs on ${page.label}: ${page.url}`, '');
  if (previous !== undefined) {
    const label = previous.workflow === undefined ? '' : `${previous.workflow} `;
    lines.push(`Previous run: [${label}run ${previous.runId}](${previous.url})`, '');
  }
  return lines.join('\n');
}

/** `text` as a markdown code span, fenced by one more backtick than its longest run of them. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  if (longest === 0) return `\`${text}\``;
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

/** The subset of the issue comments API that `ci link` reads. */
export type ApiComment = { id: number; body: string; user: { login: string; type: string } | null };

/**
 * The id of the comment `workflow` (a `slug`) owns, if any: a bot's comment carrying its marker, or the legacy one for
 * `ci`. A person's comment that quotes the marker is never taken over.
 */
export const findStickyComment = (comments: ApiComment[], workflow: string): number | undefined =>
  comments.find(
    (c) =>
      c.user?.type === 'Bot' &&
      (c.body.includes(markerOf(workflow)) || (workflow === 'ci' && c.body.startsWith(LEGACY_MARKER))),
  )?.id;

export function checkRunPayload(
  run: ApiRun,
  url: string,
): {
  name: typeof CHECK_RUN_NAME;
  head_sha: string;
  status: 'completed';
  conclusion: 'neutral';
  details_url: string;
  output: { title: string; summary: string };
} {
  return {
    name: CHECK_RUN_NAME,
    head_sha: run.head_sha,
    status: 'completed',
    conclusion: 'neutral',
    details_url: url,
    output: { title: `Report for run ${run.id}`, summary: `Report: ${url}` },
  };
}

/**
 * The run before `runId` in its channel, preferring the newest older run of the same workflow and else the one right
 * after it in the list, of any workflow; with the URL of its report, derived from this run's report `url` by swapping
 * the report paths. Undefined when the run is not on the site, is the oldest
 * in its channel, or `url` does not end in this run's report path.
 */
export function previousRun(index: SiteIndex, runId: number, url: string): PreviousRun | undefined {
  const found = locate(index, runId, url);
  if (found === undefined) return undefined;
  const older = found.channel.runs.slice(found.at + 1);
  const workflow = found.channel.runs[found.at]?.workflow;
  const prev = (workflow === undefined ? undefined : older.find((r) => r.workflow === workflow)) ?? older[0];
  if (prev === undefined) return undefined;
  return {
    runId: prev.runId,
    url: `${found.base}/${prev.reportPath}/`,
    ...(prev.workflow === undefined ? {} : { workflow: prev.workflow }),
  };
}

/**
 * The rolling report of the channel holding `runId`, its URL derived from this run's report `url` as in
 * `previousRun`. Undefined when the run is not on the site, its channel is an older per-workflow one, or `url` does
 * not end in this run's report path.
 */
export function channelPage(index: SiteIndex, runId: number, url: string): ChannelPage | undefined {
  const found = locate(index, runId, url);
  if (found === undefined || found.channel.kind === 'workflow') return undefined;
  const label =
    found.channel.kind === 'pr'
      ? `pull request #${found.key.slice('pr/'.length)}`
      : codeSpan(found.channel.headBranch);
  return { label, url: `${found.base}/${found.key}/` };
}

/** The channel holding `runId`, its position there, and the site's base URL (`url` minus the run's report path). */
function locate(
  index: SiteIndex,
  runId: number,
  url: string,
): { key: string; channel: Channel; at: number; base: string } | undefined {
  for (const [key, channel] of Object.entries(index.channels)) {
    const at = channel.runs.findIndex((r) => r.runId === runId);
    if (at < 0) continue;
    const tail = `/${(channel.runs[at] as SiteRun).reportPath}/`;
    if (!url.endsWith(tail)) return undefined;
    return { key, channel, at, base: url.slice(0, -tail.length) };
  }
  return undefined;
}

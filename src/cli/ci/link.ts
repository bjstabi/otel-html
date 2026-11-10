import { type ApiJob, type ApiRun, CHECK_RUN_NAME } from './github-api.js';
import { type Channel, IN_PROGRESS, type SiteIndex, slug } from './site.js';
import { codeSpan, MARKER, summaryTable } from './summary.js';

/** The pure side of `ci link`: the sticky pull request comment and the check run that point at a run's report. */

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
  const lines = [markerOf(slug(run.name)), summaryTable(run, jobs), `Report: ${url}`, ''];
  if (page !== undefined) lines.push(`All runs on ${page.label}: ${page.url}`, '');
  if (previous !== undefined) {
    const label = previous.workflow === undefined ? '' : `${previous.workflow} `;
    lines.push(`Previous run: [${label}run ${previous.runId}](${previous.url})`, '');
  }
  return lines.join('\n');
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
 * The run before `runId` in channel `key` of the live index: the channel's newest run that is neither this run nor
 * `in_progress`, preferring `workflow`, with its report under `baseUrl`. It does not need the
 * index to list this run (D57). Undefined when the channel has no such run.
 */
export function previousRunOf(
  index: SiteIndex,
  key: string,
  runId: number,
  baseUrl: string,
  workflow: string,
): PreviousRun | undefined {
  const candidates = (index.channels[key]?.runs ?? []).filter(
    (r) => r.runId !== runId && r.conclusion !== IN_PROGRESS,
  );
  const prev = candidates.find((r) => r.workflow === workflow) ?? candidates[0];
  if (prev === undefined) return undefined;
  return {
    runId: prev.runId,
    url: `${baseUrl}/${prev.reportPath}/`,
    ...(prev.workflow === undefined ? {} : { workflow: prev.workflow }),
  };
}

/** The rolling report of channel `key` under `baseUrl`, as `channelFor` describes the channel (D57); none for an older per-workflow channel. */
export function channelPageOf(
  key: string,
  channel: Omit<Channel, 'runs'>,
  baseUrl: string,
): ChannelPage | undefined {
  if (channel.kind === 'workflow') return undefined;
  const label =
    channel.kind === 'pr' ? `pull request #${key.slice('pr/'.length)}` : codeSpan(channel.headBranch);
  return { label, url: `${baseUrl}/${key}/` };
}

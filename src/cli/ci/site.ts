import { z } from 'zod';
import type { ApiPull, ApiRun } from './github-api.js';

/** The published site's index (`/index.json`): channels of runs, and the pure operations on it. */

export type SiteRun = {
  runId: number;
  attempt: number;
  conclusion: string;
  headSha: string;
  headBranch: string;
  completedAt: string;
  runUrl: string;
  /** Site-relative folder of the run's report, e.g. `ci/runs/123`. */
  reportPath: string;
  /** The run's workflow name (`ci`, `load`); absent in entries written before it was recorded. */
  workflow?: string;
};
export type Channel = {
  /**
   * `workflow`: a default-branch workflow, at `<slug>/`. `branch`: a pull request's head branch, every workflow's runs
   * on it, at `branch/<...>/`. `pr`: the older per pull request channel at `pr/<n>/`, still parsed and cleaned up.
   */
  kind: 'workflow' | 'branch' | 'pr';
  /** `ci`, or `#12 Fix the thing`. */
  title: string;
  headBranch: string;
  /** A branch channel's open pull requests: every one that placed a run and has not closed yet. */
  prs?: readonly number[];
  /** The single pull request of a branch channel written before `prs`; read as `[pr]` (see `prsOf`). */
  pr?: number;
  /** A branch channel's head repository, `owner/repo`. */
  headRepo?: string;
  /** Newest first. */
  runs: SiteRun[];
};
export type SiteIndex = { version: 1; channels: Record<string, Channel> };

const siteRunSchema = z.object({
  runId: z.number(),
  attempt: z.number(),
  conclusion: z.string(),
  headSha: z.string(),
  headBranch: z.string(),
  completedAt: z.string(),
  runUrl: z.string(),
  reportPath: z.string(),
  workflow: z.string().exactOptional(),
});
export const siteIndexSchema: z.ZodType<SiteIndex> = z.object({
  version: z.literal(1),
  channels: z.record(
    z.string(),
    z.object({
      kind: z.enum(['workflow', 'branch', 'pr']),
      title: z.string(),
      headBranch: z.string(),
      prs: z.array(z.number()).exactOptional(),
      pr: z.number().exactOptional(),
      headRepo: z.string().exactOptional(),
      runs: z.array(siteRunSchema),
    }),
  ),
});

/** The index in `text` (an `index.json`), or an empty one when there is none. Throws on a malformed index. */
export function parseSiteIndex(text: string | undefined): SiteIndex {
  if (text === undefined) return { version: 1, channels: {} };
  return siteIndexSchema.parse(JSON.parse(text));
}

/** `name` lower-cased with each run of non-alphanumerics one `-`, trimmed: never contains `--`. */
const slugPart = (name: string, fallback: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;

/** Top-level folders that are not workflow channels: `pr/<n>` (legacy pull request channels) and `branch/<...>`. */
const RESERVED = new Set(['pr', 'branch']);

/**
 * A workflow's channel key and folder. `pr` and `branch` are taken (they hold the pull request and branch channels),
 * so a workflow named `pr` gets `pr--workflow` and one named `branch` gets `branch--workflow`. Runs of
 * non-alphanumerics collapse to one `-`, so no name slugs to those.
 */
export const slug = (name: string): string => {
  const key = slugPart(name, 'workflow');
  return RESERVED.has(key) ? `${key}--workflow` : key;
};

export const reportUrl = (baseUrl: string, reportPath: string): string => `${baseUrl}/${reportPath}/`;

/**
 * The open pull requests a finished run belongs to, the exact-commit ones first: those whose head is the run's
 * commit, then those whose head branch is the run's branch in the same repository (the pull request may have moved
 * on since; a fork's branch of the same name is not this run's branch).
 */
export function pullsOfRun(run: ApiRun, pulls: ApiPull[]): ApiPull[] {
  const open = pulls.filter((p) => p.state === 'open');
  const exact = open.filter((p) => p.head.sha === run.head_sha);
  const sameRepo = (p: ApiPull): boolean =>
    p.head.repo != null &&
    run.head_repository != null &&
    p.head.repo.full_name === run.head_repository.full_name;
  const moved = open.filter(
    (p) => p.head.sha !== run.head_sha && p.head.ref === run.head_branch && sameRepo(p),
  );
  return [...exact, ...moved];
}

/** Whether `run` is a run of the default branch of its own repository (not a fork's branch of the same name). */
export const isDefaultBranchRun = (run: ApiRun, defaultBranch: string): boolean =>
  run.head_branch === defaultBranch &&
  run.head_repository != null &&
  run.head_repository.full_name === run.repository.full_name;

/**
 * The pull requests whose sticky comment links `run`: none for a default-branch run (it is published to the
 * workflow's channel even when an open pull request's head is, or contains, the same commit), else `pullsOfRun`.
 */
export const pullsToLink = (run: ApiRun, pulls: ApiPull[], defaultBranch: string): ApiPull[] =>
  isDefaultBranchRun(run, defaultBranch) ? [] : pullsOfRun(run, pulls);

/**
 * The branch channel key of pull request `pr`'s head. A branch the index already has keeps its key for life. A new
 * one gets `branch/<branch>` for a branch of `repository`, `branch/<owner>--<branch>` for a fork's (no slug has `--`,
 * so the two cannot meet), or, when that key is held by another branch (`feat/x` and `feat-x`) or the head repository
 * is gone, the first of `<key>--pr-<n>`, `<key>--pr-<n>--2`, ... that nothing holds.
 */
function branchKey(pr: ApiPull, repository: string, index: SiteIndex): string {
  const ref = slugPart(pr.head.ref, 'branch');
  const headRepo = pr.head.repo?.full_name;
  const own = Object.entries(index.channels).find(
    ([, ch]) =>
      ch.kind === 'branch' &&
      ch.headBranch === pr.head.ref &&
      ch.headRepo === headRepo &&
      // with no head repository there is nothing to tell two forks' branches apart but the pull request
      (headRepo !== undefined || prsOf(ch).includes(pr.number)),
  );
  if (own !== undefined) return own[0];
  const base =
    headRepo === undefined || headRepo === repository
      ? `branch/${ref}`
      : `branch/${slugPart(headRepo.split('/')[0] ?? '', 'fork')}--${ref}`;
  if (headRepo !== undefined && index.channels[base] === undefined) return base;
  const suffixed = `${base}--pr-${pr.number}`;
  let key = suffixed;
  for (let k = 2; index.channels[key] !== undefined; k++) key = `${suffixed}--${k}`;
  return key;
}

/**
 * Where a finished run is published: the workflow's channel when the run is the default branch of this repository,
 * else the branch channel of the open pull request of the run's commit or branch (see `pullsOfRun`), which every
 * workflow's runs on that branch share; anything else (a fork push, a feature branch with no open pull) is not
 * published. `index` is the site's current index, for the branch key's collision guard.
 */
export function channelFor(
  run: ApiRun,
  pulls: ApiPull[],
  defaultBranch: string,
  index: SiteIndex = { version: 1, channels: {} },
): { key: string; channel: Omit<Channel, 'runs'> } | undefined {
  if (isDefaultBranchRun(run, defaultBranch)) {
    const key = slug(run.name);
    return { key, channel: { kind: 'workflow', title: key, headBranch: defaultBranch } };
  }
  const pr = pullsOfRun(run, pulls)[0];
  if (pr === undefined) return undefined;
  const headRepo = pr.head.repo?.full_name;
  return {
    key: branchKey(pr, run.repository.full_name, index),
    channel: {
      kind: 'branch',
      title: `#${pr.number} ${pr.title}`,
      headBranch: pr.head.ref,
      prs: [pr.number],
      ...(headRepo === undefined ? {} : { headRepo }),
    },
  };
}

/** A channel's pull requests: its `prs`, or the older single `pr`. */
const prsOf = (ch: Pick<Channel, 'prs' | 'pr'>): readonly number[] =>
  ch.prs ?? (ch.pr === undefined ? [] : [ch.pr]);

/**
 * `index` with `run` in channel `key` (created if absent, metadata refreshed); the same runId is replaced in place. A
 * branch channel's `prs` gather the pull requests that placed runs on it (the older `pr` folds in).
 */
export function placeRun(
  index: SiteIndex,
  key: string,
  channel: Omit<Channel, 'runs'>,
  run: SiteRun,
): SiteIndex {
  const held = index.channels[key];
  const { pr: _legacy, ...meta } = channel;
  const prs = [...new Set([...(held === undefined ? [] : prsOf(held)), ...prsOf(channel)])].sort(
    (a, b) => a - b,
  );
  const runs = [...(held?.runs ?? [])];
  const at = runs.findIndex((r) => r.runId === run.runId);
  if (at >= 0) runs[at] = run;
  else runs.push(run);
  runs.sort((a, b) =>
    a.completedAt === b.completedAt ? b.runId - a.runId : a.completedAt < b.completedAt ? 1 : -1,
  );
  const next: Channel = channel.kind === 'branch' ? { ...meta, prs, runs } : { ...channel, runs };
  return { ...index, channels: { ...index.channels, [key]: next } };
}

/**
 * Keeps the newest `keep.workflow` runs per workflow channel and `keep.pr` per branch (or legacy pr) channel;
 * `remove` is the dropped runs' report paths.
 */
export function applyRetention(
  index: SiteIndex,
  keep: { workflow: number; pr: number },
): { index: SiteIndex; remove: string[] } {
  const remove: string[] = [];
  const channels: Record<string, Channel> = {};
  for (const [key, ch] of Object.entries(index.channels)) {
    const n = ch.kind === 'workflow' ? keep.workflow : keep.pr;
    remove.push(...ch.runs.slice(n).map((r) => r.reportPath));
    channels[key] = { ...ch, runs: ch.runs.slice(0, n) };
  }
  return { index: { ...index, channels }, remove };
}

/** The channel's report paths (site-relative), oldest first: the order the rolling report merges them in. */
export function rollingInputs(channel: Channel): string[] {
  return channel.runs.map((r) => r.reportPath).reverse();
}

/**
 * `index` without pull request `pr`: it leaves each branch channel's `prs`, and a channel left with none is removed,
 * as is the legacy `pr/<pr>`. `removed` are the removed channel keys and `remove` their report paths; `updated` are
 * the channels kept for another open pull request. A pull request the index does not have changes nothing.
 */
export function removePr(
  index: SiteIndex,
  pr: number,
): { index: SiteIndex; remove: string[]; removed: string[]; updated: string[] } {
  const removed: string[] = [];
  const updated: string[] = [];
  const channels: Record<string, Channel> = {};
  const remove: string[] = [];
  for (const [key, ch] of Object.entries(index.channels)) {
    const prs = prsOf(ch);
    if (key === `pr/${pr}` || (prs.includes(pr) && prs.length === 1)) {
      removed.push(key);
      remove.push(...ch.runs.map((r) => r.reportPath));
    } else if (prs.includes(pr)) {
      updated.push(key);
      const { pr: _legacy, ...rest } = ch;
      channels[key] = { ...rest, prs: prs.filter((n) => n !== pr) };
    } else channels[key] = ch;
  }
  if (removed.length === 0 && updated.length === 0) return { index, remove, removed, updated };
  return { index: { ...index, channels }, remove, removed, updated };
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--link:#58a6ff}}
body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:44rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1rem;margin:2rem 0 .5rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
a{color:var(--link)}ul{list-style:none;margin:0;padding:0}li{padding:.5rem 0;border-top:1px solid var(--line)}.meta{color:var(--muted);font-size:.875rem}`;

const page = (title: string, body: string, head = ''): string =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>\n`;

const entry = (href: string, label: string, ch: Channel, branch?: string): string => {
  const latest = ch.runs[0];
  const runs =
    latest === undefined
      ? 'no runs'
      : `${esc(latest.conclusion)} &middot; ${esc(latest.completedAt.slice(0, 10))} &middot; ${ch.runs.length} run${ch.runs.length === 1 ? '' : 's'}`;
  const meta = branch === undefined ? runs : `<code>${esc(branch)}</code> &middot; ${runs}`;
  return `<li><a href="${esc(href)}">${esc(label)}</a><div class="meta">${meta}</div></li>`;
};

/** A pull request channel's newest pull request, else the `<n>` of a legacy `pr/<n>` key. */
const prNumber = (key: string, ch: Channel): number => Math.max(...prsOf(ch), Number(key.slice(3)) || 0);

/** A branch channel's branch as people name it: `feat`, or `owner:feat` for a fork's. */
const branchLabel = (ch: Channel, repository: string): string =>
  ch.headRepo === undefined || ch.headRepo === repository
    ? ch.headBranch
    : `${ch.headRepo.split('/')[0]}:${ch.headBranch}`;

/**
 * The static landing page: the default branch's workflows, then the pull requests' branch channels and any legacy pr
 * channels (highest pull request number first).
 */
export function renderLanding(index: SiteIndex, repository: string): string {
  const all = Object.entries(index.channels);
  const workflows = all.filter(([, c]) => c.kind === 'workflow').sort(([a], [b]) => a.localeCompare(b));
  const prs = all
    .filter(([, c]) => c.kind !== 'workflow')
    .sort(([a, x], [b, y]) => prNumber(b, y) - prNumber(a, x) || a.localeCompare(b));
  const section = (heading: string, rows: string[]): string =>
    rows.length === 0 ? '' : `<h2>${heading}</h2><ul>${rows.join('')}</ul>`;
  const body =
    `<h1>${esc(repository)}</h1><div class="meta">CI reports</div>` +
    section(
      'Default branch',
      workflows.map(([key, c]) => entry(`${key}/`, key === 'ci' ? 'main' : c.title, c)),
    ) +
    section(
      'Pull requests',
      prs.map(([key, c]) => entry(`${key}/`, c.title, c, branchLabel(c, repository))),
    ) +
    (all.length === 0 ? '<p>No reports yet.</p>' : '');
  return page(`${repository} CI reports`, body);
}

/** A page that forwards to `relativeTarget` (a path relative to the page). */
export function renderRedirect(relativeTarget: string): string {
  const t = esc(relativeTarget);
  return page(
    'Redirecting',
    `<p>Redirecting to <a href="${t}">${t}</a>.</p>`,
    `<meta http-equiv="refresh" content="0; url=${t}">`,
  );
}

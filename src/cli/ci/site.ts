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
  /** Site-relative folder of the run's report, e.g. `pr/12/runs/123`. */
  reportPath: string;
  /** The run's workflow name (`ci`, `load`); absent in entries written before it was recorded. */
  workflow?: string;
};
export type Channel = {
  /**
   * `branch`: a branch of this repository (today the default branch), at `branch/<slug>/`. `pr`: an open pull request,
   * at `pr/<n>/`. Both hold the runs of every workflow. `workflow`: the older per-workflow channel at `<slug>/`, read
   * only so that the next publish can drop it (see `dropWorkflowChannels`).
   */
  kind: 'branch' | 'pr' | 'workflow';
  /** `main`, or `#12 Fix the thing`. */
  title: string;
  headBranch: string;
  /** A pull request channel's head repository, `owner/repo`. */
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
const KINDS = ['branch', 'pr', 'workflow'] as const;
const channelSchema: z.ZodType<Channel> = z.object({
  kind: z.enum(KINDS),
  title: z.string(),
  headBranch: z.string(),
  headRepo: z.string().exactOptional(),
  runs: z.array(siteRunSchema),
});
export const siteIndexSchema: z.ZodType<SiteIndex> = z.object({
  version: z.literal(1),
  channels: z.record(z.string(), channelSchema),
});
const looseIndexSchema = z.object({ version: z.literal(1), channels: z.record(z.string(), z.unknown()) });

/**
 * The index in `text` (an `index.json`), or an empty one when there is none. A channel of a kind this version does
 * not know (written by a newer otel-html), or one it cannot read, is skipped with `warn` rather than failing every
 * publish and cleanup; the next write leaves it out. Throws when the index itself is malformed or another version.
 */
export function parseSiteIndex(
  text: string | undefined,
  warn: (message: string) => void = () => {},
): SiteIndex {
  if (text === undefined) return { version: 1, channels: {} };
  const loose = looseIndexSchema.parse(JSON.parse(text));
  const channels: Record<string, Channel> = {};
  for (const [key, value] of Object.entries(loose.channels)) {
    const parsed = channelSchema.safeParse(value);
    if (parsed.success) {
      channels[key] = parsed.data;
      continue;
    }
    const kind = (value as { kind?: unknown } | null)?.kind;
    warn(
      typeof kind === 'string' && !(KINDS as readonly string[]).includes(kind)
        ? `skipping channel ${key} of kind ${kind}, which this otel-html does not know`
        : `skipping channel ${key}, which is not readable: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  return { version: 1, channels };
}

/** `name` lower-cased with each run of non-alphanumerics one `-`, trimmed; `workflow` when nothing is left. */
export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workflow';

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
 * branch's channel even when an open pull request's head is, or contains, the same commit), else `pullsOfRun`.
 */
export const pullsToLink = (run: ApiRun, pulls: ApiPull[], defaultBranch: string): ApiPull[] =>
  isDefaultBranchRun(run, defaultBranch) ? [] : pullsOfRun(run, pulls);

/**
 * Where a finished run is published: `branch/<slug(defaultBranch)>` when the run is the default branch of this
 * repository, else `pr/<n>` for the open pull request of the run's commit or branch (see `pullsOfRun`); anything else
 * (a fork push, a feature branch with no open pull) is not published. Each channel holds every workflow's runs.
 */
export function channelFor(
  run: ApiRun,
  pulls: ApiPull[],
  defaultBranch: string,
): { key: string; channel: Omit<Channel, 'runs'> } | undefined {
  if (isDefaultBranchRun(run, defaultBranch)) {
    return {
      key: `branch/${slug(defaultBranch)}`,
      channel: { kind: 'branch', title: defaultBranch, headBranch: defaultBranch },
    };
  }
  const pr = pullsOfRun(run, pulls)[0];
  if (pr === undefined) return undefined;
  const headRepo = pr.head.repo?.full_name;
  return {
    key: `pr/${pr.number}`,
    channel: {
      kind: 'pr',
      title: `#${pr.number} ${pr.title}`,
      headBranch: pr.head.ref,
      ...(headRepo === undefined ? {} : { headRepo }),
    },
  };
}

/** `index` with `run` in channel `key` (created if absent, metadata refreshed); the same runId is replaced in place. */
export function placeRun(
  index: SiteIndex,
  key: string,
  channel: Omit<Channel, 'runs'>,
  run: SiteRun,
): SiteIndex {
  const runs = [...(index.channels[key]?.runs ?? [])];
  const at = runs.findIndex((r) => r.runId === run.runId);
  if (at >= 0) runs[at] = run;
  else runs.push(run);
  runs.sort((a, b) =>
    a.completedAt === b.completedAt ? b.runId - a.runId : a.completedAt < b.completedAt ? 1 : -1,
  );
  return { ...index, channels: { ...index.channels, [key]: { ...channel, runs } } };
}

/**
 * Keeps, in each channel, the newest `keep.branch` (branch channels) or `keep.pr` (pull request channels) runs of each
 * workflow; runs recorded without a workflow count as one more. `remove` is the dropped runs' report paths.
 */
export function applyRetention(
  index: SiteIndex,
  keep: { branch: number; pr: number },
): { index: SiteIndex; remove: string[] } {
  const remove: string[] = [];
  const channels: Record<string, Channel> = {};
  for (const [key, ch] of Object.entries(index.channels)) {
    const n = ch.kind === 'pr' ? keep.pr : keep.branch;
    const seen = new Map<string | undefined, number>();
    const runs = ch.runs.filter((r) => {
      const count = (seen.get(r.workflow) ?? 0) + 1;
      seen.set(r.workflow, count);
      if (count <= n) return true;
      remove.push(r.reportPath);
      return false;
    });
    channels[key] = { ...ch, runs };
  }
  return { index: { ...index, channels }, remove };
}

/**
 * `index` without the older per-workflow channels (`ci`, `load`), and their folders to delete. Their runs are not
 * moved: the default branch's page starts over at `branch/<default>/`.
 */
export function dropWorkflowChannels(index: SiteIndex): { index: SiteIndex; remove: string[] } {
  const remove: string[] = [];
  const channels: Record<string, Channel> = {};
  for (const [key, ch] of Object.entries(index.channels)) {
    // a workflow channel's key is one folder, never one of the `branch/` and `pr/` trees
    if (ch.kind === 'workflow' && !key.includes('/') && key !== 'branch' && key !== 'pr') remove.push(key);
    else if (ch.kind !== 'workflow') channels[key] = ch;
  }
  return remove.length === 0 ? { index, remove } : { index: { ...index, channels }, remove };
}

/** The channel's report paths (site-relative), oldest first: the order the rolling report merges them in. */
export function rollingInputs(channel: Channel): string[] {
  return channel.runs.map((r) => r.reportPath).reverse();
}

/** `index` without channel `key`, and its report paths; a missing key changes nothing. */
export function removeChannel(index: SiteIndex, key: string): { index: SiteIndex; remove: string[] } {
  const ch = index.channels[key];
  if (ch === undefined) return { index, remove: [] };
  const { [key]: _gone, ...channels } = index.channels;
  return { index: { ...index, channels }, remove: ch.runs.map((r) => r.reportPath) };
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

/** A pull request channel's head branch as people name it: `feat`, or `owner:feat` for a fork's. */
const branchLabel = (ch: Channel, repository: string): string =>
  ch.headRepo === undefined || ch.headRepo === repository
    ? ch.headBranch
    : `${ch.headRepo.split('/')[0]}:${ch.headBranch}`;

/** The static landing page: the branches, then the pull requests (highest number first), each its rolling report. */
export function renderLanding(index: SiteIndex, repository: string): string {
  const all = Object.entries(index.channels);
  const branches = all.filter(([, c]) => c.kind === 'branch').sort(([a], [b]) => a.localeCompare(b));
  const prs = all
    .filter(([, c]) => c.kind === 'pr')
    .sort(([a], [b]) => Number(b.slice(3)) - Number(a.slice(3)));
  const section = (heading: string, rows: string[]): string =>
    rows.length === 0 ? '' : `<h2>${heading}</h2><ul>${rows.join('')}</ul>`;
  const body =
    `<h1>${esc(repository)}</h1><div class="meta">CI reports</div>` +
    section(
      'Branches',
      branches.map(([key, c]) => entry(`${key}/`, c.title, c)),
    ) +
    section(
      'Pull requests',
      prs.map(([key, c]) => entry(`${key}/`, c.title, c, branchLabel(c, repository))),
    ) +
    (branches.length + prs.length === 0 ? '<p>No reports yet.</p>' : '');
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

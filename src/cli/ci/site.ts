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
};
export type Channel = {
  kind: 'workflow' | 'pr';
  /** `ci`, or `#12 Fix the thing`. */
  title: string;
  headBranch: string;
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
});
export const siteIndexSchema: z.ZodType<SiteIndex> = z.object({
  version: z.literal(1),
  channels: z.record(
    z.string(),
    z.object({
      kind: z.enum(['workflow', 'pr']),
      title: z.string(),
      headBranch: z.string(),
      runs: z.array(siteRunSchema),
    }),
  ),
});

/** The index in `text` (an `index.json`), or an empty one when there is none. Throws on a malformed index. */
export function parseSiteIndex(text: string | undefined): SiteIndex {
  if (text === undefined) return { version: 1, channels: {} };
  return siteIndexSchema.parse(JSON.parse(text));
}

export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workflow';

export const reportUrl = (baseUrl: string, reportPath: string): string => `${baseUrl}/${reportPath}/`;

/**
 * Where a finished run is published: the open pull request whose head is the run's commit, else the workflow's
 * channel when the run is the default branch of this repository; anything else (a fork push, a feature branch
 * with no open pull) is not published.
 */
export function channelFor(
  run: ApiRun,
  pulls: ApiPull[],
  defaultBranch: string,
): { key: string; channel: Omit<Channel, 'runs'> } | undefined {
  const pr = pulls.find((p) => p.state === 'open' && p.head.sha === run.head_sha);
  if (pr !== undefined) {
    return {
      key: `pr/${pr.number}`,
      channel: { kind: 'pr', title: `#${pr.number} ${pr.title}`, headBranch: pr.head.ref },
    };
  }
  if (run.head_branch === defaultBranch && run.head_repository?.full_name === run.repository.full_name) {
    const key = slug(run.name);
    return { key, channel: { kind: 'workflow', title: key, headBranch: defaultBranch } };
  }
  return undefined;
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
  else runs.unshift(run);
  return { ...index, channels: { ...index.channels, [key]: { ...channel, runs } } };
}

/** Keeps the newest `keep.workflow` / `keep.pr` runs per channel; `remove` is the dropped runs' report paths. */
export function applyRetention(
  index: SiteIndex,
  keep: { workflow: number; pr: number },
): { index: SiteIndex; remove: string[] } {
  const remove: string[] = [];
  const channels: Record<string, Channel> = {};
  for (const [key, ch] of Object.entries(index.channels)) {
    const n = ch.kind === 'pr' ? keep.pr : keep.workflow;
    remove.push(...ch.runs.slice(n).map((r) => r.reportPath));
    channels[key] = { ...ch, runs: ch.runs.slice(0, n) };
  }
  return { index: { ...index, channels }, remove };
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

const entry = (href: string, label: string, ch: Channel): string => {
  const latest = ch.runs[0];
  const meta =
    latest === undefined
      ? 'no runs'
      : `${esc(latest.conclusion)} &middot; ${esc(latest.completedAt.slice(0, 10))} &middot; ${ch.runs.length} run${ch.runs.length === 1 ? '' : 's'}`;
  return `<li><a href="${esc(href)}">${esc(label)}</a><div class="meta">${meta}</div></li>`;
};

/** The static landing page: the default branch's workflows, then open pull requests (highest number first). */
export function renderLanding(index: SiteIndex, repository: string): string {
  const all = Object.entries(index.channels);
  const workflows = all.filter(([, c]) => c.kind === 'workflow').sort(([a], [b]) => a.localeCompare(b));
  const prs = all
    .filter(([, c]) => c.kind === 'pr')
    .sort(([a], [b]) => Number(b.slice(3)) - Number(a.slice(3)));
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
      prs.map(([key, c]) => entry(`${key}/`, c.title, c)),
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

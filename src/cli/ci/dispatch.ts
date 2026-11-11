import type { CliIo } from '../io.js';
import { type ApiRun, apiHeaders, envVar, type Fetch, getJson, messageOf, say } from './github-api.js';

const TIMEOUT_MS = 15_000;
/** Looking for the run the dispatch started: one deadline for the whole wait, listings included, polling every 4 s. */
const WATCH_BUDGET_MS = 20_000;
const WATCH_WAIT_MS = 4_000;
/** A listing is taken from just before the dispatch, so clock skew between runner and API does not hide the run. */
const WATCH_SKEW_MS = 5_000;

type Watch = { sleep?: (ms: number) => Promise<void>; now?: () => number; skip?: boolean };
type DispatchedRun = {
  id: number;
  html_url: string;
  status: string;
  conclusion: string | null;
  created_at: string;
};

/**
 * §5.2: wakes the deployer. Dispatches `workflow` on the repository's default branch when run `runId` is a
 * same-repository run whose actor is a `User` (a bot's or a fork's run cannot be trusted to ask for a deploy). Any
 * failure (a 403 included) is one log line; never throws.
 *
 * After the 204 it looks for the run it started, for up to about 20 s. GitHub answers 204 even when it then refuses
 * to start the run (a `GITHUB_TOKEN` dispatch ends in `startup_failure`), so a run that concluded `startup_failure`
 * is one warning. Not finding the run, or any failure while looking, says nothing.
 */
export async function runDispatch(
  o: { workflow: string; repository: string; runId: number },
  io: CliIo,
  fetchFn: Fetch = fetch,
  watch: Watch = {},
): Promise<void> {
  const api = envVar(io, 'GITHUB_API_URL') ?? 'https://api.github.com';
  const token = envVar(io, 'GITHUB_TOKEN');
  const repo = `${api}/repos/${o.repository}`;
  try {
    const run = (await getJson<ApiRun>(`${repo}/actions/runs/${o.runId}`, token, TIMEOUT_MS, fetchFn)).body;
    if (run.actor?.type !== 'User' || run.head_repository?.full_name !== run.repository.full_name) {
      say(io, `otel-html dispatch: run ${o.runId} is not a same-repository run by a user; not dispatching`);
      return;
    }
    const { default_branch: ref } = (
      await getJson<{ default_branch: string }>(repo, token, TIMEOUT_MS, fetchFn)
    ).body;
    const url = `${repo}/actions/workflows/${o.workflow}/dispatches`;
    const dispatchedAt = (watch.now ?? Date.now)();
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    say(io, `otel-html dispatch: ${o.workflow} dispatched on ${ref}`);
    if (watch.skip !== true) await warnIfNotStarted(o, repo, token, dispatchedAt, io, fetchFn, watch);
  } catch (e) {
    say(io, `otel-html dispatch: not dispatched: ${messageOf(e)}`);
  }
}

async function warnIfNotStarted(
  o: { workflow: string },
  repo: string,
  token: string | undefined,
  dispatchedAt: number,
  io: CliIo,
  fetchFn: Fetch,
  watch: Watch,
): Promise<void> {
  const sleep = watch.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const since = new Date(dispatchedAt - WATCH_SKEW_MS).toISOString();
  const list = `${repo}/actions/workflows/${o.workflow}/runs?event=workflow_dispatch&per_page=5&created=${encodeURIComponent(`>=${since}`)}`;
  try {
    const now = watch.now ?? Date.now;
    const deadline = now() + WATCH_BUDGET_MS;
    for (;;) {
      const wait = Math.min(WATCH_WAIT_MS, deadline - now());
      if (wait <= 0) return;
      await sleep(wait);
      const left = deadline - now();
      if (left <= 0) return;
      const { workflow_runs: runs } = (
        await getJson<{ workflow_runs?: DispatchedRun[] }>(list, token, Math.min(TIMEOUT_MS, left), fetchFn)
      ).body;
      const newest = (runs ?? []).reduce<DispatchedRun | undefined>(
        (a, r) => (a === undefined || Date.parse(r.created_at) > Date.parse(a.created_at) ? r : a),
        undefined,
      );
      if (newest === undefined) continue;
      if (newest.conclusion === 'startup_failure') {
        say(
          io,
          `::warning::otel-html dispatch: ${newest.html_url} could not start: the dispatch token cannot start workflows, so the site updates only when ci-report ends and on the schedule. See "Dispatch token" in the README.`,
        );
        return;
      }
      if (newest.conclusion !== null || newest.status === 'in_progress') return;
    }
  } catch {
    // The dispatch itself succeeded; what became of the run is a courtesy.
  }
}

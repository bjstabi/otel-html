import type { CliIo } from '../io.js';
import { type ApiRun, apiHeaders, envVar, type Fetch, getJson, messageOf, say } from './github-api.js';

const TIMEOUT_MS = 15_000;

/**
 * §5.2: wakes the deployer. Dispatches `workflow` on the repository's default branch when run `runId` is a
 * same-repository run whose actor is a `User` (a bot's or a fork's run cannot be trusted to ask for a deploy). Any
 * failure (a 403 included) is one log line; never throws.
 */
export async function runDispatch(
  o: { workflow: string; repository: string; runId: number },
  io: CliIo,
  fetchFn: Fetch = fetch,
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
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    say(io, `otel-html dispatch: ${o.workflow} dispatched on ${ref}`);
  } catch (e) {
    say(io, `otel-html dispatch: not dispatched: ${messageOf(e)}`);
  }
}

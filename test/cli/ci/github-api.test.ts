import { expect, test } from 'vitest';
import {
  fetchJobs,
  fetchPaged,
  fetchPullsForSha,
  jobsUrl,
  parseNextLink,
  sendJson,
} from '../../../src/cli/ci/github-api.js';

test('jobsUrl names the attempt', () => {
  expect(jobsUrl({ apiUrl: 'https://api.github.com', repository: 'o/r', runId: 1, runAttempt: 2 })).toBe(
    'https://api.github.com/repos/o/r/actions/runs/1/attempts/2/jobs?per_page=100',
  );
});

test('parseNextLink finds rel="next"', () => {
  const h = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
  expect(parseNextLink(h)).toBe('https://api.github.com/x?page=2');
  expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeUndefined();
  expect(parseNextLink(null)).toBeUndefined();
});

const page = (body: unknown, link?: string, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: link === undefined ? {} : { link } });

test('fetchPaged follows rel="next" and sends the token', async () => {
  const seen: [string, string | null][] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push([url, new Headers(init?.headers).get('authorization')]);
    return url.endsWith('page=2')
      ? page({ jobs: [{ id: 2 }] })
      : page({ jobs: [{ id: 1 }] }, '<https://x/p?page=2>; rel="next"');
  };
  const jobs = await fetchPaged<{ jobs: { id: number }[] }, { id: number }>(
    'https://x/p?page=1',
    'tok',
    1000,
    (b) => b.jobs,
    fetchFn,
  );
  expect(jobs).toEqual([{ id: 1 }, { id: 2 }]);
  expect(seen).toEqual([
    ['https://x/p?page=1', 'Bearer tok'],
    ['https://x/p?page=2', 'Bearer tok'],
  ]);
});

test('fetchJobs reads the attempt and fails naming the URL on a non-2xx answer', async () => {
  const i = { apiUrl: 'https://x', repository: 'o/r', runId: 1, runAttempt: 2 };
  expect(await fetchJobs(i, undefined, 1000, async () => page({}))).toEqual([]);
  await expect(fetchJobs(i, undefined, 1000, async () => page({}, undefined, 403))).rejects.toThrow(
    /attempts\/2\/jobs.* answered 403/,
  );
});

test('sendJson sends JSON with the token, decodes the answer and names the URL on failure', async () => {
  let seen: { url: string; init: RequestInit | undefined } | undefined;
  const ok = async (url: string, init?: RequestInit): Promise<Response> => {
    seen = { url, init };
    return page({ id: 7 }, undefined, 201);
  };
  expect(await sendJson('POST', 'https://x/c', { a: 1 }, 'tok', 1000, ok)).toEqual({ id: 7 });
  const h = new Headers(seen?.init?.headers);
  expect(seen?.init?.method).toBe('POST');
  expect(seen?.init?.body).toBe('{"a":1}');
  expect(h.get('content-type')).toBe('application/json');
  expect(h.get('authorization')).toBe('Bearer tok');
  await expect(
    sendJson('PATCH', 'https://x/c', {}, 'tok', 1000, async () => page({}, undefined, 422)),
  ).rejects.toThrow(/https:\/\/x\/c answered 422/);
});

test('fetchPullsForSha follows the Link header and concatenates', async () => {
  const pull = (n: number) => ({ number: n, title: 't', state: 'open', head: { sha: 's', ref: 'r' } });
  const urls: string[] = [];
  const fetchFn = async (url: string): Promise<Response> => {
    urls.push(url);
    return url.endsWith('page=2') ? page([pull(2)]) : page([pull(1)], '<https://x/next?page=2>; rel="next"');
  };
  const i = { apiUrl: 'https://x', repository: 'o/r', sha: 'abc' };
  expect((await fetchPullsForSha(i, undefined, 1000, fetchFn)).map((p) => p.number)).toEqual([1, 2]);
  expect(urls[0]).toBe('https://x/repos/o/r/commits/abc/pulls?per_page=100');
});

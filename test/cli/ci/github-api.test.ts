import { expect, test } from 'vitest';
import { fetchJobs, fetchPaged, jobsUrl, parseNextLink } from '../../../src/cli/ci/github-api.js';

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

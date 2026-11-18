import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { fetchWorkflowFile, matchJob, parseWorkflow } from '../../../src/cli/ci/workflow-file.js';

const text = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');

describe('parseWorkflow', () => {
  const jobs = parseWorkflow(text);
  test('finds the jobs with their needs and conditions', () => {
    const ids = jobs.map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining(['changes', 'check', 'e2e', 'coverage']));
    const coverage = jobs.find((j) => j.id === 'coverage');
    expect(coverage?.needs).toContain('changes');
    expect(coverage?.condition).toContain('push');
  });
  test('needs may be a string', () => {
    const [j] = parseWorkflow('jobs:\n  a:\n    needs: b\n    steps: []\n');
    expect(j).toEqual({ id: 'a', name: null, needs: ['b'], condition: null });
  });
  test('text that is not a workflow has no jobs', () => {
    expect(parseWorkflow('just: text')).toEqual([]);
  });
});

describe('matchJob', () => {
  const jobs = parseWorkflow(text);
  test('matches by id and by id prefixed to a matrix entry', () => {
    expect(matchJob(jobs, 'e2e (chromium)')?.id).toBe('e2e');
    expect(matchJob(jobs, 'check')?.id).toBe('check');
    expect(matchJob(jobs, 'nope')).toBeNull();
  });
  test('a name: matches with expressions as wildcards', () => {
    const expr = ['$', '{{ matrix.os }}'].join('');
    const named = parseWorkflow(`jobs:\n  a:\n    name: build ${expr}\n    runs-on: x\n`);
    expect(matchJob(named, 'build linux')?.id).toBe('a');
    expect(matchJob(named, 'a')).toBeNull();
  });
  test('a static name: matches a matrix entry as a prefix', () => {
    const named = parseWorkflow(`jobs:\n  a:\n    name: Build\n    runs-on: x\n`);
    expect(matchJob(named, 'Build')?.id).toBe('a');
    expect(matchJob(named, 'Build (ubuntu)')?.id).toBe('a');
    expect(matchJob(named, 'Builder')).toBeNull();
  });
});

describe('fetchWorkflowFile', () => {
  test('decodes the contents API answer', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return Response.json({ content: Buffer.from('jobs: {}\n').toString('base64') });
    }) as unknown as typeof fetch;
    const got = await fetchWorkflowFile({
      fetch: f,
      apiUrl: 'https://api.github.com',
      repository: 'o/r',
      path: '.github/workflows/ci.yml',
      ref: 'abc',
      token: 't',
    });
    expect(got).toBe('jobs: {}\n');
    expect(urls[0]).toBe('https://api.github.com/repos/o/r/contents/.github/workflows/ci.yml?ref=abc');
  });
  test('a 404 throws', async () => {
    const f = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(
      fetchWorkflowFile({ fetch: f, apiUrl: 'a', repository: 'o/r', path: 'p', ref: 'r', token: 't' }),
    ).rejects.toThrow(/404/);
  });
});

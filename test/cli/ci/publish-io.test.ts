import { describe, expect, test, vi } from 'vitest';
import type { ApiJob } from '../../../src/cli/ci/github-api.js';
import { fetchJobLog, mergeSkippingBad } from '../../../src/cli/ci/publish-io.js';

const job = { id: 7, name: 'build' } as ApiJob;
const base = { apiUrl: 'https://api.test', repository: 'o/r', job, token: 'secret' };

describe('fetchJobLog', () => {
  test('follows the redirect without the Authorization header', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://blob.test/log?sig=1' } })
        : new Response('the log');
    });
    const warn = vi.fn();
    expect(await fetchJobLog({ ...base, fetch, warn })).toBe('the log');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer secret');
    expect(calls[0]?.url).toBe('https://api.test/repos/o/r/actions/jobs/7/logs');
    expect(calls[1]?.url).toBe('https://blob.test/log?sig=1');
    expect(calls[1]?.init?.headers).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  test('a 404 gives no log and a warning', async () => {
    const warn = vi.fn();
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    expect(await fetchJobLog({ ...base, fetch, warn })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('no log for job build: answered 404');
  });

  test('the scheme check ignores case and refuses garbage', async () => {
    for (const [location, ok] of [
      ['HTTPS://blob.test/x', true],
      ['not a url', false],
    ] as const) {
      const fetch = vi.fn(async (url: string) =>
        url.startsWith('https://api')
          ? new Response(null, { status: 302, headers: { location } })
          : new Response('log'),
      );
      expect(await fetchJobLog({ ...base, fetch, warn: vi.fn() })).toBe(ok ? 'log' : undefined);
    }
  });

  test('a non-https redirect is refused', async () => {
    const warn = vi.fn();
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://evil.test/x' } }),
    );
    expect(await fetchJobLog({ ...base, fetch, warn })).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  test('a network error is a warning', async () => {
    const warn = vi.fn();
    const fetch = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await fetchJobLog({ ...base, fetch, warn })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('no log for job build: boom');
  });
});

describe('mergeSkippingBad', () => {
  const args = (merge: (i: string[], o: string, p: boolean) => Promise<string>, warn = vi.fn()) => ({
    merge,
    required: ['trace'],
    optional: ['a', 'bad', 'c'],
    out: 'out',
    probeOut: (n: number) => `probe-${n}`,
    warn,
  });

  test('good reports merge on the first try', async () => {
    const merge = vi.fn(async () => 'ok');
    const r = await mergeSkippingBad(args(merge));
    expect(merge).toHaveBeenCalledOnce();
    expect(r.inputs).toEqual(['trace', 'a', 'bad', 'c']);
  });

  test('one corrupt report is skipped and the rest merge', async () => {
    const merge = vi.fn(async (inputs: string[]) => {
      if (inputs.includes('bad')) throw new Error('unreadable format');
      return 'ok';
    });
    const warn = vi.fn();
    const r = await mergeSkippingBad(args(merge, warn));
    expect(r.inputs).toEqual(['trace', 'a', 'c']);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('skipping bad');
  });

  test('the final merge is not a probe even with a single input; probes are', async () => {
    const merge = vi.fn(async (inputs: string[], _out: string, _probe: boolean) => {
      if (inputs.includes('bad')) throw new Error('unreadable');
      return 'ok';
    });
    const r = await mergeSkippingBad({ ...args(merge), optional: ['bad'] });
    expect(r.inputs).toEqual(['trace']);
    expect(merge.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [['trace', 'bad'], false],
      [['bad'], true],
      [['trace'], false],
    ]);
  });

  test('a failure no report explains is rethrown', async () => {
    const merge = vi.fn(async (inputs: string[]) => {
      if (inputs.length > 1) throw new Error('disk full');
      return 'ok';
    });
    await expect(mergeSkippingBad(args(merge))).rejects.toThrow('disk full');
  });
});

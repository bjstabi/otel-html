import { describe, expect, test } from 'vitest';
import {
  checkRun,
  parseLoadArgs,
  parseManifestJs,
  parseMaxRssKb,
  parseReceived,
  planWorkload,
} from '../../scripts/load-receiver-plan.js';

describe('parseLoadArgs', () => {
  test('defaults to 1M spans, 10M logs and 8 workers', () => {
    const args = parseLoadArgs(['--out', '/tmp/r']);
    expect(args).toMatchObject({ spans: 1_000_000, logs: 10_000_000, workers: 8, out: '/tmp/r' });
    expect(args.image).toMatch(/telemetrygen:v\d+\.\d+\.\d+$/);
  });

  test('reads every flag', () => {
    expect(
      parseLoadArgs([
        '--spans',
        '20000',
        '--logs',
        '100000',
        '--workers',
        '4',
        '--out',
        'o',
        '--image',
        'x:1',
      ]),
    ).toEqual({ spans: 20_000, logs: 100_000, workers: 4, out: 'o', image: 'x:1' });
  });

  test('requires --out', () => {
    expect(() => parseLoadArgs([])).toThrow(/--out/);
  });

  test.each([
    ['--spans', 'abc'],
    ['--logs', '0'],
    ['--workers', '-1'],
    ['--spans', '1.5'],
  ])('rejects %s %s', (flag, value) => {
    expect(() => parseLoadArgs(['--out', 'o', flag, value])).toThrow(flag);
  });

  test('rejects an unknown flag', () => {
    expect(() => parseLoadArgs(['--out', 'o', '--bogus'])).toThrow();
  });
});

describe('planWorkload', () => {
  test('splits spans over workers at 2 spans per trace, and logs per worker', () => {
    expect(planWorkload({ spans: 1_000_000, logs: 10_000_000, workers: 8 })).toEqual({
      tracesPerWorker: 62_500,
      logsPerWorker: 1_250_000,
    });
  });

  test('refuses a span count that does not split exactly', () => {
    expect(() => planWorkload({ spans: 1_000_002, logs: 8, workers: 8 })).toThrow(/spans/);
  });

  test('refuses a log count that does not split exactly', () => {
    expect(() => planWorkload({ spans: 16, logs: 9, workers: 8 })).toThrow(/logs/);
  });
});

describe('output parsing', () => {
  test('parseMaxRssKb reads the preload line', () => {
    expect(parseMaxRssKb('noise\nMAXRSS 412345\n')).toBe(412_345);
    expect(parseMaxRssKb('nothing')).toBeNull();
  });

  test('parseReceived reads the serve summary', () => {
    expect(parseReceived('wrote x\nreceived 120 requests (2 refused); 3 records rejected\n')).toEqual({
      refused: 2,
      rejected: 3,
    });
    expect(parseReceived('wrote x\nreceived 120 requests (0 rejected)\n')).toBeNull(); // the old wording
    expect(parseReceived('wrote x\n')).toBeNull();
  });

  test('parseManifestJs reads the pushed manifest', () => {
    const m = parseManifestJs(
      '__OH__.push("manifest",{"complete":true,"totals":{"spans":4,"logs":5,"metrics":0}});',
    );
    expect(m).toEqual({ complete: true, totals: { spans: 4, logs: 5, metrics: 0 } });
  });

  test('parseManifestJs rejects other content', () => {
    expect(() => parseManifestJs('hello')).toThrow(/manifest/);
  });
});

describe('checkRun', () => {
  const ok = { complete: true, totals: { spans: 10, logs: 20, metrics: 0 } };
  const want = { spans: 10, logs: 20 };

  test('passes a complete, exact, unrejected, small run', () => {
    expect(checkRun({ manifest: ok, want, received: { refused: 0, rejected: 0 }, rssKb: 100_000 })).toEqual(
      [],
    );
  });

  test('names every failed assertion', () => {
    const failures = checkRun({
      manifest: { complete: false, totals: { spans: 9, logs: 19, metrics: 0 } },
      want,
      received: { refused: 1, rejected: 2 },
      rssKb: 512 * 1024,
    });
    expect(failures).toHaveLength(6);
    expect(failures.join('\n')).toMatch(/complete/);
    expect(failures.join('\n')).toMatch(/spans: expected 10, got 9/);
    expect(failures.join('\n')).toMatch(/logs: expected 20, got 19/);
    expect(failures.join('\n')).toMatch(/1 requests refused/);
    expect(failures.join('\n')).toMatch(/2 records rejected/);
    expect(failures.join('\n')).toMatch(/RSS/);
  });

  test('a missing RSS or received line is a failure, not a pass', () => {
    expect(checkRun({ manifest: ok, want, received: null, rssKb: null })).toHaveLength(2);
  });
});

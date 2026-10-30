import { describe, expect, test } from 'vitest';
import {
  checkRun,
  formatServeFigures,
  logsArgs,
  parseLoadArgs,
  parseManifestJs,
  parseMaxRssKb,
  parseReceived,
  parseStallStats,
  planWorkload,
  SPANS_PER_SECOND_PER_WORKER,
  tracesArgs,
} from '../../scripts/load-receiver-plan.js';

describe('parseLoadArgs', () => {
  test('defaults to 1M spans, 1M logs and 8 workers', () => {
    const args = parseLoadArgs(['--out', '/tmp/r']);
    expect(args).toMatchObject({ spans: 1_000_000, logs: 1_000_000, workers: 8, out: '/tmp/r' });
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

  test('parseStallStats reads the loop and GC lines', () => {
    expect(parseStallStats('LOOP p99 12.3 max 480.0\nGC count 152 total 3200.5 max 77.0\n')).toEqual({
      loopP99Ms: 12.3,
      loopMaxMs: 480,
      gcCount: 152,
      gcTotalMs: 3200.5,
      gcMaxMs: 77,
    });
    expect(parseStallStats('')).toBeNull();
    expect(parseStallStats('LOOP p99 1.0 max 2.0\n')).toBeNull();
  });

  test('formatServeFigures summarises RSS, loop and GC, and says what is missing', () => {
    expect(
      formatServeFigures('MAXRSS 524288\nLOOP p99 12.3 max 480.0\nGC count 152 total 3200.5 max 77.0\n'),
    ).toBe('peak RSS 512 MB, loop p99 12.3 ms max 480.0 ms, gc 152 pauses 3200.5 ms max 77.0 ms');
    expect(formatServeFigures('')).toBe('peak RSS not reported, stalls not reported');
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

describe('tracesArgs', () => {
  const args = tracesArgs('img:1', 4317, 8, 62_500);

  test('paces the generator', () => {
    const i = args.indexOf('--rate');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(String(SPANS_PER_SECOND_PER_WORKER));
  });

  test('targets the gRPC endpoint with the per-worker count', () => {
    expect(args[0]).toBe('img:1');
    expect(args).toContain('traces');
    expect(args).toContain('127.0.0.1:4317');
    expect(args.join(' ')).toContain('--traces 62500');
    expect(args.join(' ')).toContain('--workers 8');
  });
});

describe('logsArgs', () => {
  const args = logsArgs('img:1', 4318, 8, 125_000);

  test('stays unthrottled over HTTP', () => {
    expect(args.join(' ')).toContain('--rate 0');
    expect(args).toContain('--otlp-http');
  });

  test('targets the HTTP endpoint with the per-worker count', () => {
    expect(args).toContain('127.0.0.1:4318');
    expect(args.join(' ')).toContain('--logs 125000');
    expect(args.join(' ')).toContain('--workers 8');
  });
});

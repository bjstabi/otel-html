import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CliDeps } from '../../src/cli/commands/receive.js';
import type { CliIo, StopSignal } from '../../src/cli/io.js';
import { runCli } from '../../src/cli/program.js';
import type { FileSystem } from '../../src/writer/ports.js';
import { createTestWriter, type TestWriter } from '../../test-support/writer-deps.js';
import { allSpans, manifestOf, spansRequest } from '../writer/helpers.js';

interface Harness {
  stdout: string;
  stderr: string;
  fire(signal?: StopSignal): void;
  result: Promise<number>;
}

function start(w: TestWriter, argv: readonly string[], fs?: FileSystem, extra: CliDeps = {}): Harness {
  const handlers = new Set<(s: StopSignal) => void>();
  const h: Harness = {
    stdout: '',
    stderr: '',
    fire: (signal = 'SIGINT') => {
      for (const fn of [...handlers]) fn(signal);
    },
    result: Promise.resolve(0),
  };
  const io: CliIo = {
    stdout: (s) => {
      h.stdout += s;
    },
    stderr: (s) => {
      h.stderr += s;
    },
    env: {},
    cwd: '/work',
    signals: {
      on(fn) {
        handlers.add(fn);
        return () => handlers.delete(fn);
      },
    },
    spawn,
  };
  h.result = runCli(argv, io, { ...w.deps, ...(fs === undefined ? {} : { fs }), ...extra });
  return h;
}

async function listening(h: Harness): Promise<string> {
  await vi.waitFor(() => expect(h.stdout).toContain('\n'));
  return h.stdout.split('\n')[0] ?? '';
}

function httpOf(line: string): string {
  const m = /^listening on (http:\/\/\S+) /.exec(line);
  if (m?.[1] === undefined) throw new Error(`no http address in ${line}`);
  return m[1];
}

async function post(base: string, count: number, firstIndex = 0): Promise<number> {
  const res = await fetch(`${base}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spansRequest(count, 0, firstIndex)),
  });
  return res.status;
}

const open: Harness[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    h.fire();
    h.fire();
    await h.result.catch(() => undefined);
  }
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

describe('serve', () => {
  test('favours heap size once, before the report is created', async () => {
    const w = createTestWriter();
    let lockAtCall: Promise<boolean> | undefined;
    let calls = 0;
    const h = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc'], undefined, {
      favourShortPauses: () => {
        calls++;
        lockAtCall = w.fs.exists('out/data/state/lock.json');
      },
    });
    open.push(h);
    await listening(h);
    expect(calls).toBe(1);
    expect(await lockAtCall).toBe(false);
  });

  test('receives until SIGINT, then finishes the report and prints the totals', async () => {
    const w = createTestWriter();
    const h = start(w, ['serve', '-o', 'out', '--http', '0', '--grpc', '0']);
    open.push(h);
    const line = await listening(h);
    expect(line).toMatch(
      /^listening on http:\/\/127\.0\.0\.1:\d+ \(OTLP\/HTTP\) and 127\.0\.0\.1:\d+ \(OTLP\/gRPC\), writing out; press Ctrl-C to finish$/,
    );
    expect(await post(httpOf(line), 2)).toBe(200);
    h.fire('SIGINT');
    expect(await h.result).toBe(0);
    expect(h.stdout).toContain('wrote out: 2 spans, 0 logs, 0 metric points\n');
    expect(h.stdout).toContain('received 1 requests (0 refused); 0 records rejected\n');
    expect(h.stdout).not.toContain('refused:');
    expect(h.stderr).toBe('');
    expect(manifestOf(w, 'out').complete).toBe(true);
    expect(allSpans(w, 'out')).toHaveLength(2);
  });

  test('a burst followed by silence reaches the report before SIGINT', async () => {
    const w = createTestWriter();
    const h = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc']);
    open.push(h);
    expect(await post(httpOf(await listening(h)), 1)).toBe(200);
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() => expect(manifestOf(w, 'out').totals.spans).toBeGreaterThanOrEqual(1));
    h.fire('SIGINT');
    expect(await h.result).toBe(0);
    expect(manifestOf(w, 'out').complete).toBe(true);
  });

  test('refused requests are counted and broken down by outcome in the summary', async () => {
    const w = createTestWriter();
    const h = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc']);
    open.push(h);
    const base = httpOf(await listening(h));
    const bad = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' };
    const statuses = [
      (await fetch(`${base}/v1/traces`, bad)).status,
      (await fetch(`${base}/v1/traces`, bad)).status,
      (await fetch(`${base}/v1/traces`, bad)).status,
      (await fetch(`${base}/v1/traces`, { ...bad, headers: { 'content-type': 'text/plain' } })).status,
    ];
    expect(statuses).toEqual([400, 400, 400, 415]);
    h.fire();
    expect(await h.result).toBe(0);
    expect(h.stdout).toContain('received 4 requests (4 refused); 0 records rejected\n');
    expect(h.stdout).toContain('refused: 3 invalid, 1 unsupported\n');
  });

  test('a config file that disables both transports is a usage error before the report is created', async () => {
    const w = createTestWriter();
    await w.fs.mkdirp('/work');
    await w.fs.writeTextAtomic(
      '/work/cfg.yaml',
      'receiver:\n  http:\n    enabled: false\n  grpc:\n    enabled: false\n',
    );
    const h = start(w, ['serve', '-o', 'out', '--config', '/work/cfg.yaml']);
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain('no receiver transport enabled');
    expect(await w.fs.exists('out')).toBe(false);
  });

  test('SIGTERM finishes the report too', async () => {
    const w = createTestWriter();
    const h = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc']);
    open.push(h);
    await listening(h);
    h.fire('SIGTERM');
    expect(await h.result).toBe(0);
    expect(manifestOf(w, 'out').complete).toBe(true);
  });

  test('--no-grpc names only HTTP', async () => {
    const w = createTestWriter();
    const h = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc']);
    open.push(h);
    expect(await listening(h)).toMatch(
      /^listening on http:\/\/127\.0\.0\.1:\d+ \(OTLP\/HTTP\), writing out; press Ctrl-C to finish$/,
    );
    h.fire();
    expect(await h.result).toBe(0);
  });

  test('--no-http names only gRPC', async () => {
    const w = createTestWriter();
    const h = start(w, ['serve', '-o', 'out', '--no-http', '--grpc', '0']);
    open.push(h);
    expect(await listening(h)).toMatch(
      /^listening on 127\.0\.0\.1:\d+ \(OTLP\/gRPC\), writing out; press Ctrl-C to finish$/,
    );
    h.fire();
    expect(await h.result).toBe(0);
  });

  test('--no-http --no-grpc is a usage error', async () => {
    const w = createTestWriter();
    const h = start(w, ['serve', '-o', 'out', '--no-http', '--no-grpc']);
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain('no receiver transport enabled');
    expect(await w.fs.exists('out')).toBe(false);
  });

  test.each([['abc'], ['1.5'], ['70000'], ['-1']])('--http %s is a usage error', async (port) => {
    const w = createTestWriter();
    const h = start(w, ['serve', '-o', 'out', '--http', port]);
    expect(await h.result).toBe(2);
    expect(h.stdout).toBe('');
    expect(h.stderr).toContain('is not a port');
  });

  test('serve twice into one folder appends', async () => {
    const w = createTestWriter();
    const first = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc']);
    open.push(first);
    expect(await post(httpOf(await listening(first)), 2)).toBe(200);
    first.fire();
    expect(await first.result).toBe(0);

    const second = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc']);
    open.push(second);
    expect(await post(httpOf(await listening(second)), 3, 10)).toBe(200);
    second.fire();
    expect(await second.result).toBe(0);
    expect(second.stdout).toContain('wrote out: 5 spans');
    expect(allSpans(w, 'out')).toHaveLength(5);
  });

  test('--append keeps the spans of an existing report', async () => {
    const w = createTestWriter();
    const first = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc']);
    open.push(first);
    expect(await post(httpOf(await listening(first)), 2)).toBe(200);
    first.fire();
    expect(await first.result).toBe(0);

    const second = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc', '--append']);
    open.push(second);
    expect(await post(httpOf(await listening(second)), 3, 10)).toBe(200);
    second.fire();
    expect(await second.result).toBe(0);
    expect(second.stdout).toContain('wrote out: 5 spans');
    expect(allSpans(w, 'out')).toHaveLength(5);
  });

  test('a second signal while a write is stuck exits 130 and releases the lock', async () => {
    const w = createTestWriter();
    let reached = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((_, reject) => {
      release = () => reject(new Error('killed mid-write'));
    });
    const fs: FileSystem = {
      ...w.fs,
      async writeTextAtomic(p, text) {
        // The final checkpoint is the only manifest written with complete: true.
        if (p.endsWith('data/manifest.js') && text.includes('"complete":true')) {
          reached = true;
          await gate;
        }
        return w.fs.writeTextAtomic(p, text);
      },
    };
    const h = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc'], fs);
    open.push(h);
    expect(await post(httpOf(await listening(h)), 1)).toBe(200);
    h.fire();
    await vi.waitFor(() => expect(reached).toBe(true));
    h.fire();
    expect(await h.result).toBe(130);
    expect(h.stdout).toContain('interrupted; the report is at its last checkpoint\n');
    release?.();
    expect(manifestOf(w, 'out').complete).toBe(false);
    await vi.waitFor(async () => expect(await w.fs.exists('out/data/state/lock.json')).toBe(false));
  });

  test('a stop signal while the lock is being taken exits 130 with the lock already released', async () => {
    const w = createTestWriter();
    let waiting: (() => void) | undefined;
    const entered = new Promise<void>((r) => {
      waiting = r;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fs: FileSystem = {
      ...w.fs,
      async createExclusive(p, text) {
        if (p.endsWith('lock.json')) {
          waiting?.();
          await gate;
        }
        return w.fs.createExclusive(p, text);
      },
    };
    const h = start(w, ['serve', '-o', 'out', '--http', '0', '--no-grpc'], fs);
    open.push(h);
    await entered;
    h.fire();
    release?.();
    expect(await h.result).toBe(130);
    expect(h.stdout).toContain('interrupted\n');
    expect(await w.fs.exists('out/data/state/lock.json')).toBe(false);
  });

  test('a stop signal while the transports bind exits 130 with the lock released and no port bound', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const addr = probe.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    await new Promise((r) => probe.close(r));
    const w = createTestWriter();
    let fire: () => void = () => undefined;
    const signalling: TestWriter = {
      ...w,
      deps: {
        ...w.deps,
        tracer: {
          startSpan(name, attrs) {
            // startReceiver opens this span right before it binds.
            if (name === 'otel-html.receive') fire();
            return w.deps.tracer.startSpan(name, attrs);
          },
        },
      },
    };
    const h = start(signalling, ['serve', '-o', 'out', '--http', String(port), '--no-grpc']);
    fire = () => h.fire();
    open.push(h);
    expect(await h.result).toBe(130);
    expect(await w.fs.exists('out/data/state/lock.json')).toBe(false);
    const again = createServer();
    servers.push(again);
    await new Promise<void>((r, j) => {
      again.once('error', j);
      again.listen(port, '127.0.0.1', r);
    });
  });

  test('a port already in use exits 1 naming EADDRINUSE', async () => {
    const taken = createServer();
    servers.push(taken);
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const addr = taken.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const w = createTestWriter();
    const h = start(w, ['serve', '-o', 'out', '--http', String(port), '--no-grpc']);
    expect(await h.result).toBe(1);
    expect(h.stderr).toContain('EADDRINUSE');
    expect(h.stderr).toContain('--http');
    expect(await w.fs.exists('out/data/state/lock.json')).toBe(false);
  });
});

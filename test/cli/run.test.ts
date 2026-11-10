import { type ChildProcess, spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { fromBinary, fromJson } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CliIo, StopSignal } from '../../src/cli/io.js';
import type { CliDeps } from '../../src/cli/program.js';
import { runCli } from '../../src/cli/program.js';
import { LOCK_PATH } from '../../src/format/paths.js';
import { ExportTraceServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { Status_StatusCode } from '../../src/model/gen/opentelemetry/proto/trace/v1/trace_pb.js';
import { at } from '../../src/writer/checkpoint.js';
import { acquireLock } from '../../src/writer/lock.js';
import type { FileSystem } from '../../src/writer/ports.js';
import { createTestWriter, type TestWriter } from '../../test-support/writer-deps.js';
import { allSpans, cell, manifestOf } from '../writer/helpers.js';

interface Harness {
  stdout: string;
  stderr: string;
  /** Output the child wrote to its (piped) stdout. */
  child: string;
  fire(signal?: StopSignal): void;
  result: Promise<number>;
}

/** Posts one span as a child of the TRACEPARENT it was given, then exits with argv[1] (or waits to be killed). */
const CHILD = `
const [, version, traceId, parentSpanId] = /^(\\w+)-(\\w+)-(\\w+)-01$/.exec(process.env.TRACEPARENT ?? '') ?? [];
const body = { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'child' }, spans: [{
  traceId, parentSpanId, spanId: '00000000000000aa', name: 'child-work', kind: 1,
  startTimeUnixNano: String(Date.now() * 1e6), endTimeUnixNano: String(Date.now() * 1e6 + 1000) }] }] }] };
const res = await fetch(process.env.OTEL_EXPORTER_OTLP_ENDPOINT + '/v1/traces', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
if (res.status !== 200) process.exit(99);
if (process.argv[1] === 'sleep') { process.stdout.write('ready\\n'); setInterval(() => undefined, 1000); }
else process.exit(Number(process.argv[1] ?? 0));
`;

function start(
  w: TestWriter,
  argv: readonly string[],
  env: Record<string, string> = {},
  spawnOverride?: CliIo['spawn'],
  fs?: FileSystem,
  extra: CliDeps = {},
): Harness {
  const handlers = new Set<(s: StopSignal) => void>();
  const h: Harness = {
    stdout: '',
    stderr: '',
    child: '',
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
    env,
    cwd: '/work',
    signals: {
      on(fn) {
        handlers.add(fn);
        return () => handlers.delete(fn);
      },
    },
    // The child's stdout is piped so the test can see when it is ready; its stderr stays visible.
    spawn:
      spawnOverride ??
      (((command: string, args: readonly string[], options: object): ChildProcess => {
        const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'inherit'] });
        child.stdout?.on('data', (d: Buffer) => {
          h.child += d.toString();
        });
        return child;
      }) as CliIo['spawn']),
  };
  h.result = runCli(argv, io, { ...w.deps, ...(fs === undefined ? {} : { fs }), ...extra });
  return h;
}

interface RunSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  statusCode: number | null;
  statusMessage: string | null;
  service: string | null;
}

function runSpans(w: TestWriter): RunSpan[] {
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return allSpans(w, 'out').map((r) => ({
    traceId: String(cell(r, 'trace_id')),
    spanId: String(cell(r, 'span_id')),
    parentSpanId: str(cell(r, 'parent_span_id')),
    name: String(cell(r, 'name')),
    statusCode: num(cell(r, 'status_code')),
    statusMessage: str(cell(r, 'status_message')),
    service: str(cell(r, 'service_name')),
  }));
}

const node = ['--http', '0', '--no-grpc', '--', process.execPath, '-e', CHILD];
const open: Harness[] = [];
const taken: Server[] = [];

/** A listening socket on a free loopback port: a stand-in for a collector already on 4317/4318. */
async function takenPort(): Promise<number> {
  const server = createServer();
  taken.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

// The resource detectors read the real environment; a developer's own OTEL_* settings must not leak into the report.
beforeEach(() => {
  vi.stubEnv('OTEL_SERVICE_NAME', '');
  vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of taken.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const h of open.splice(0)) {
    h.fire();
    h.fire();
    await h.result.catch(() => undefined);
  }
});

describe('run', () => {
  test('TRACEPARENT in the environment is inherited: same trace id, root parented under it', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', ...node, '0'], {
      TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    open.push(h);
    expect(await h.result).toBe(0);
    const spans = runSpans(w);
    const root = spans.find((s) => s.name === 'node');
    const child = spans.find((s) => s.name === 'child-work');
    expect(root?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(root?.parentSpanId).toBe('b7ad6b7169203331');
    expect(child?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(child?.parentSpanId).toBe(root?.spanId);
  });

  test('--traceparent wins over the variable', async () => {
    const w = createTestWriter();
    const h = start(
      w,
      ['run', '-o', 'out', '--traceparent', `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`, ...node, '0'],
      {
        TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
    );
    open.push(h);
    expect(await h.result).toBe(0);
    const root = runSpans(w).find((s) => s.name === 'node');
    expect(root?.traceId).toBe('1'.repeat(32));
    expect(root?.parentSpanId).toBe('2'.repeat(16));
  });

  test('a malformed --traceparent names the flag; an empty one is still an error', async () => {
    for (const value of ['nope', '']) {
      const w = createTestWriter();
      const h = start(w, ['run', '-o', 'out', '--traceparent', value, ...node, '0']);
      open.push(h);
      expect(await h.result).toBe(2);
      expect(h.stderr).toContain('--traceparent is not a W3C traceparent');
    }
  });

  test('an empty TRACEPARENT variable is unset: a fresh trace', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', ...node, '0'], { TRACEPARENT: '' });
    open.push(h);
    expect(await h.result).toBe(0);
    const root = runSpans(w).find((s) => s.name === 'node');
    expect(root?.parentSpanId).toBeNull();
  });

  test('TRACESTATE in the environment reaches the child unchanged', async () => {
    const w = createTestWriter();
    const h = start(
      w,
      [
        'run',
        '-o',
        'out',
        '--http',
        '0',
        '--no-grpc',
        '--',
        process.execPath,
        '-e',
        'process.stdout.write(process.env.TRACESTATE ?? "unset")',
      ],
      { TRACESTATE: 'vendor=a,other=b' },
    );
    open.push(h);
    expect(await h.result).toBe(0);
    expect(h.child).toBe('vendor=a,other=b');
  });

  test.each([
    ['uppercase hex', '00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01'],
    ['another version', '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'],
    ['all-zero ids', `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`],
    ['not a traceparent', 'nope'],
  ])('a malformed TRACEPARENT (%s) is a usage error before the child starts', async (_name, value) => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', ...node, '0'], { TRACEPARENT: value });
    open.push(h);
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain('TRACEPARENT');
    expect(h.child).toBe('');
    expect(await w.fs.exists('out/data/manifest.js')).toBe(false);
  });

  test('wraps a child that exits 0: two spans in one trace, the child under the root', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', ...node, '0']);
    open.push(h);
    expect(await h.result).toBe(0);
    expect(h.stderr).toBe('');
    expect(h.stdout).toContain('wrote out: 2 spans');
    expect(manifestOf(w, 'out').complete).toBe(true);
    const spans = runSpans(w);
    expect(spans).toHaveLength(2);
    const root = spans.find((s) => s.parentSpanId === null);
    const child = spans.find((s) => s.name === 'child-work');
    expect(root?.name).toBe('node');
    expect(child?.traceId).toBe(root?.traceId);
    expect(child?.parentSpanId).toBe(root?.spanId);
    expect(root?.statusCode ?? Status_StatusCode.UNSET).toBe(Status_StatusCode.UNSET);
    expect(root?.service).toBe('node');
  });

  test('two runs in one folder keep both root spans', async () => {
    const w = createTestWriter();
    for (let i = 0; i < 2; i++) {
      const h = start(w, ['run', '-o', 'out', ...node, '0']);
      open.push(h);
      expect(await h.result).toBe(0);
    }
    const spans = runSpans(w);
    expect(spans).toHaveLength(4);
    const roots = spans.filter((s) => s.parentSpanId === null);
    expect(roots).toHaveLength(2);
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(2);
    for (const root of roots) {
      const children = spans.filter((s) => s.parentSpanId === root.spanId);
      expect(children.map((c) => c.traceId)).toEqual([root.traceId]);
    }
  });

  test('run --replace keeps only the last run', async () => {
    const w = createTestWriter();
    for (const flags of [[], ['--replace']]) {
      const h = start(w, ['run', '-o', 'out', ...flags, ...node, '0']);
      open.push(h);
      expect(await h.result).toBe(0);
    }
    const spans = runSpans(w);
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
  });

  test('a non-zero exit is the command exit code and the root span says so', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', ...node, '3']);
    open.push(h);
    expect(await h.result).toBe(3);
    const root = runSpans(w).find((s) => s.parentSpanId === null);
    expect(root?.statusCode).toBe(Status_StatusCode.ERROR);
    expect(root?.statusMessage).toBe('exit code 3');
    expect(manifestOf(w, 'out').complete).toBe(true);
  });

  test('a non-zero exit is kept when the report then fails to finish, and the failure is printed', async () => {
    const w = createTestWriter();
    const fs: FileSystem = {
      ...w.fs,
      async writeTextAtomic(p, text) {
        if (p.endsWith('data/manifest.js') && text.includes('"complete":true')) {
          throw new Error('disk full');
        }
        return w.fs.writeTextAtomic(p, text);
      },
    };
    const h = start(w, ['run', '-o', 'out', ...node, '3'], {}, undefined, fs);
    open.push(h);
    expect(await h.result).toBe(3);
    expect(h.stderr).toContain('disk full');
  });

  test('a zero exit is kept when the report fails to finish; the failure is printed', async () => {
    const w = createTestWriter();
    const fs: FileSystem = {
      ...w.fs,
      async writeTextAtomic(p, text) {
        if (p.endsWith('data/manifest.js') && text.includes('"complete":true')) {
          throw new Error('disk full');
        }
        return w.fs.writeTextAtomic(p, text);
      },
    };
    const h = start(w, ['run', '-o', 'out', ...node, '0'], {}, undefined, fs);
    open.push(h);
    expect(await h.result).toBe(0);
    expect(h.stderr).toContain('disk full');
  });

  test('SIGTERM is forwarded to the child: 143, killed by SIGTERM, report complete', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', ...node, 'sleep']);
    open.push(h);
    await vi.waitFor(() => expect(h.child).toContain('ready'));
    h.fire('SIGTERM');
    expect(await h.result).toBe(143);
    const root = runSpans(w).find((s) => s.parentSpanId === null);
    expect(root?.statusMessage).toBe('killed by SIGTERM');
    expect(manifestOf(w, 'out').complete).toBe(true);
  });

  test('a user-set endpoint is kept and a warning says so', async () => {
    const w = createTestWriter();
    const h = start(
      w,
      ['run', '-o', 'out', '--http', '0', '--no-grpc', '--', process.execPath, '-e', 'process.exit(0)'],
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://elsewhere:1',
      },
    );
    open.push(h);
    expect(await h.result).toBe(0);
    expect(h.stderr).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  test('a command that does not exist exits 1 with the spawn error', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', '--http', '0', '--no-grpc', '--', 'otel-html-no-such-command']);
    open.push(h);
    expect(await h.result).toBe(1);
    expect(h.stderr).toContain('otel-html-no-such-command');
    expect(h.stderr).toContain('ENOENT');
    expect(await w.fs.exists('out/data/manifest.js')).toBe(false);
  });

  test('an empty command is a usage error and leaves no lock', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', '--http', '0', '--no-grpc', '--', '']);
    open.push(h);
    expect(await h.result).toBe(2);
    expect(await w.fs.exists('out')).toBe(false);
  });

  test('a spawn that throws synchronously aborts the session: exit 1, no lock, no report', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', '--http', '0', '--no-grpc', '--', 'x'], {}, () => {
      throw new Error('spawn exploded');
    });
    open.push(h);
    expect(await h.result).toBe(1);
    expect(h.stderr).toContain('spawn exploded');
    expect(await w.fs.exists('out/data/state/lock.json')).toBe(false);
    expect(await w.fs.exists('out/data/manifest.js')).toBe(false);
  });

  test('no command is a usage error', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', '--http', '0', '--no-grpc']);
    expect(await h.result).toBe(2);
    expect(await w.fs.exists('out')).toBe(false);
  });

  test('a protocol whose transport is disabled is a usage error before anything starts', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', '--no-http', '--grpc', '0', '--', process.execPath, '-e', '0']);
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain('--http');
    expect(await w.fs.exists('out')).toBe(false);
  });

  test('a transport disabled only by the config file is a usage error before anything starts', async () => {
    const w = createTestWriter();
    await w.fs.mkdirp('/work');
    await w.fs.writeTextAtomic('/work/cfg.yaml', 'receiver:\n  grpc:\n    enabled: false\n');
    const h = start(
      w,
      ['run', '-o', 'out', '--config', '/work/cfg.yaml', '--http', '0', '--', process.execPath, '-e', '0'],
      {
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      },
    );
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain('--grpc');
    expect(await w.fs.exists('out')).toBe(false);
  });

  test('--export-otlp forwards the run root span after the receiver drained', async () => {
    const bodies: { type: string | undefined; body: Buffer }[] = [];
    const collector = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        bodies.push({ type: req.headers['content-type'], body: Buffer.concat(chunks) });
        res.end();
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    const address = collector.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const w = createTestWriter();
      const h = start(w, [
        'run',
        '-o',
        'out',
        '--export-otlp',
        `http://127.0.0.1:${address.port}`,
        ...node,
        '0',
      ]);
      open.push(h);
      expect(await h.result).toBe(0);
      expect(h.stdout).toContain('forwarded 2, dropped 0, failed 0');
      const names = bodies.flatMap((b) =>
        (b.type === 'application/json'
          ? fromJson(ExportTraceServiceRequestSchema, JSON.parse(b.body.toString('utf8')))
          : fromBinary(ExportTraceServiceRequestSchema, b.body)
        ).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((ss) => ss.spans.map((sp) => sp.name))),
      );
      expect(names.sort()).toEqual(['child-work', 'node']);
    } finally {
      await new Promise((r) => collector.close(r));
    }
  });

  test.each(['http/grpc', 'nonsense'])(
    '--export-otlp with OTEL_EXPORTER_OTLP_PROTOCOL=%s is a usage error',
    async (protocol) => {
      const w = createTestWriter();
      const h = start(w, ['run', '-o', 'out', '--export-otlp', 'http://127.0.0.1:1', ...node, '0'], {
        OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
      });
      expect(await h.result).toBe(2);
      expect(h.stderr).toContain('http/protobuf');
      expect(await w.fs.exists('out')).toBe(false);
    },
  );

  test('--export-otlp with the grpc protocol is a usage error naming the follow-up, before anything starts', async () => {
    const w = createTestWriter();
    const h = start(
      w,
      [
        'run',
        '-o',
        'out',
        '--grpc',
        '0',
        '--no-http',
        '--export-otlp',
        'http://127.0.0.1:1',
        '--',
        process.execPath,
        '-e',
        '0',
      ],
      { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    );
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain('--export-otlp / receiver.exportOtlp');
    expect(h.stderr).toContain('issues/259');
    expect(await w.fs.exists('out')).toBe(false);
  });

  test('an unknown protocol is a usage error before anything starts', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', '--http', '0', '--no-grpc', '--', process.execPath, '-e', '0'], {
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grcp',
    });
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain('http/protobuf');
    expect(await w.fs.exists('out')).toBe(false);
  });

  test('with the default protocol only HTTP is bound, so a taken gRPC port does not matter', async () => {
    const w = createTestWriter();
    const grpc = await takenPort();
    await w.fs.mkdirp('/work');
    await w.fs.writeTextAtomic(
      '/work/cfg.yaml',
      `receiver:\n  host: 127.0.0.1\n  grpc:\n    port: ${grpc}\n  http:\n    port: 0\n`,
    );
    const h = start(w, [
      'run',
      '-o',
      'out',
      '--config',
      '/work/cfg.yaml',
      '--',
      process.execPath,
      '-e',
      CHILD,
      '0',
    ]);
    open.push(h);
    expect(await h.result).toBe(0);
    expect(h.stderr).toBe('');
    expect(runSpans(w)).toHaveLength(2);
  });

  test('OTEL_EXPORTER_OTLP_PROTOCOL=grpc binds gRPC and leaves HTTP unbound', async () => {
    const w = createTestWriter();
    const http = await takenPort();
    await w.fs.mkdirp('/work');
    await w.fs.writeTextAtomic(
      '/work/cfg.yaml',
      `receiver:\n  host: 127.0.0.1\n  http:\n    port: ${http}\n  grpc:\n    port: 0\n`,
    );
    const h = start(
      w,
      ['run', '-o', 'out', '--config', '/work/cfg.yaml', '--', process.execPath, '-e', '0'],
      { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    );
    open.push(h);
    expect(await h.result).toBe(0);
    expect(h.stderr).toBe('');
  });

  test('an explicit --grpc <port> is still bound under the HTTP protocol', async () => {
    const w = createTestWriter();
    const grpc = await takenPort();
    const h = start(w, [
      'run',
      '-o',
      'out',
      '--host',
      '127.0.0.1',
      '--http',
      '0',
      '--grpc',
      String(grpc),
      '--',
      process.execPath,
      '-e',
      '0',
    ]);
    open.push(h);
    expect(await h.result).toBe(0);
    expect(h.stderr).toContain('EADDRINUSE');
    expect(h.stderr).toContain('--grpc');
    expect(h.stderr).toContain('without it');
  });

  test('a taken HTTP port runs the command without a report: exit 0, the bind error and its hint are printed', async () => {
    const w = createTestWriter();
    const http = await takenPort();
    const h = start(w, [
      'run',
      '-o',
      'out',
      '--host',
      '127.0.0.1',
      '--http',
      String(http),
      '--no-grpc',
      '--',
      process.execPath,
      '-e',
      'process.exit(0)',
    ]);
    open.push(h);
    expect(await h.result).toBe(0);
    expect(h.stderr).toContain('EADDRINUSE');
    expect(h.stderr).toContain('--http');
    expect(h.stderr).toContain(String(http));
    expect(h.stderr).toContain('without it');
    expect(await w.fs.exists('out/data/manifest.js')).toBe(false);
  });

  test('a stop signal while a failed start releases its lock exits 130 and does not run the command', async () => {
    const w = createTestWriter();
    const http = await takenPort();
    let releasing!: () => void;
    const removing = new Promise<void>((resolve) => {
      releasing = resolve;
    });
    let removeStarted!: () => void;
    const removeStart = new Promise<void>((resolve) => {
      removeStarted = resolve;
    });
    const fs: FileSystem = {
      ...w.fs,
      async remove(p) {
        removeStarted();
        await removing;
        return w.fs.remove(p);
      },
    };
    const marker = 'ran-anyway';
    const h = start(
      w,
      [
        'run',
        '-o',
        'out',
        '--host',
        '127.0.0.1',
        '--http',
        String(http),
        '--no-grpc',
        '--',
        process.execPath,
        '-e',
        `console.log('${marker}')`,
      ],
      {},
      undefined,
      fs,
    );
    open.push(h);
    await removeStart;
    h.fire('SIGINT');
    releasing();
    expect(await h.result).toBe(130);
    expect(h.child).not.toContain(marker);
    expect(h.stderr).not.toContain('without it');
  });

  test('a signal while the command runs without a report is forwarded: 128 + n', async () => {
    const w = createTestWriter();
    const http = await takenPort();
    const h = start(w, [
      'run',
      '-o',
      'out',
      '--host',
      '127.0.0.1',
      '--http',
      String(http),
      '--no-grpc',
      '--',
      process.execPath,
      '-e',
      "console.log('ready'); setInterval(() => undefined, 1000)",
    ]);
    open.push(h);
    await vi.waitFor(() => expect(h.child).toContain('ready'));
    h.fire('SIGTERM');
    expect(await h.result).toBe(143);
  });

  test('a taken HTTP port keeps a non-zero command exit code', async () => {
    const w = createTestWriter();
    const http = await takenPort();
    const h = start(w, [
      'run',
      '-o',
      'out',
      '--host',
      '127.0.0.1',
      '--http',
      String(http),
      '--no-grpc',
      '--',
      process.execPath,
      '-e',
      'process.exit(3)',
    ]);
    open.push(h);
    expect(await h.result).toBe(3);
    expect(h.stderr).toContain('without it');
  });

  test('the command without a report inherits the environment unchanged', async () => {
    const w = createTestWriter();
    const http = await takenPort();
    const seen: (Record<string, string | undefined> | undefined)[] = [];
    const h = start(
      w,
      [
        'run',
        '-o',
        'out',
        '--host',
        '127.0.0.1',
        '--http',
        String(http),
        '--no-grpc',
        '--',
        process.execPath,
        '-e',
        'process.exit(["OTEL_EXPORTER_OTLP_ENDPOINT","OTEL_EXPORTER_OTLP_PROTOCOL","TRACEPARENT"].some((k) => process.env[k] !== undefined) ? 4 : 0)',
      ],
      { FOO: 'bar' },
      ((command: string, args: readonly string[], options: { env?: Record<string, string | undefined> }) => {
        seen.push(options.env);
        return spawn(command, args, {
          stdio: 'inherit',
          ...(options.env === undefined ? {} : { env: options.env }),
        });
      }) as CliIo['spawn'],
    );
    open.push(h);
    expect(await h.result).toBe(0);
    expect(seen).toEqual([{ FOO: 'bar' }]);
  });

  test('a report locked by a live process runs the command without a report', async () => {
    const w = createTestWriter();
    const lock = await acquireLock(w.deps, at('out', LOCK_PATH));
    try {
      const h = start(w, [
        'run',
        '-o',
        'out',
        '--http',
        '0',
        '--no-grpc',
        '--',
        process.execPath,
        '-e',
        'process.exit(0)',
      ]);
      open.push(h);
      expect(await h.result).toBe(0);
      expect(h.stderr).toContain('locked');
      expect(h.stderr).toContain('without it');
    } finally {
      await lock.release();
    }
  });
});

import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CliDeps } from '../../src/cli/commands/receive.js';
import type { CliIo, StopSignal } from '../../src/cli/io.js';
import { runCli } from '../../src/cli/program.js';
import { decodeColumns } from '../../src/format/columns.js';
import { chunkKey } from '../../src/format/paths.js';
import { SPAN_COLUMNS } from '../../src/format/specs.js';
import type { AnyValue } from '../../src/model/anyvalue.js';
import { Status_StatusCode } from '../../src/model/gen/opentelemetry/proto/trace/v1/trace_pb.js';
import type { SpanRecord } from '../../src/model/records.js';
import type { FileSystem } from '../../src/writer/ports.js';
import { createTestWriter, type TestWriter } from '../../test-support/writer-deps.js';
import { manifestOf, readDataFile } from '../writer/helpers.js';

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

interface Chunk {
  spans: SpanRecord[];
  serviceOf(span: SpanRecord): AnyValue | undefined;
}

function chunkOf(w: TestWriter): Chunk {
  const n = manifestOf(w, 'out').chunks.find((c) => c.signal === 'spans')?.n;
  if (n === undefined) throw new Error('no span chunk');
  const decoded = decodeColumns(
    SPAN_COLUMNS as never,
    readDataFile(w, 'out', `data/${chunkKey('spans', n)}.js`),
  );
  const rows = decoded.rows as SpanRecord[];
  return {
    spans: rows,
    serviceOf: (s) => {
      const r = decoded.resources[s.resource];
      return r?.attributes.get('service.name');
    },
  };
}

/** Every span of every span chunk in the report. */
function allChunks(w: TestWriter): { spans: SpanRecord[] } {
  const spans: SpanRecord[] = [];
  for (const c of manifestOf(w, 'out').chunks.filter((c) => c.signal === 'spans')) {
    const decoded = decodeColumns(
      SPAN_COLUMNS as never,
      readDataFile(w, 'out', `data/${chunkKey('spans', c.n)}.js`),
    );
    spans.push(...(decoded.rows as SpanRecord[]));
  }
  return { spans };
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
  test('favours heap size once, before the report is created and the child is spawned', async () => {
    const w = createTestWriter();
    let calls = 0;
    let spawned = false;
    let lockAtCall: Promise<boolean> | undefined;
    const spawnOverride = ((command: string, args: readonly string[], options: object): ChildProcess => {
      spawned = true;
      return spawn(command, args, options);
    }) as CliIo['spawn'];
    const h = start(w, ['run', '-o', 'out', ...node, '0'], {}, spawnOverride, undefined, {
      favourHeapSize: () => {
        calls++;
        expect(spawned).toBe(false);
        lockAtCall = w.fs.exists('out/data/state/lock.json');
      },
    });
    open.push(h);
    expect(await h.result).toBe(0);
    expect(calls).toBe(1);
    expect(spawned).toBe(true);
    expect(await lockAtCall).toBe(false);
  });

  test('wraps a child that exits 0: two spans in one trace, the child under the root', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', ...node, '0']);
    open.push(h);
    expect(await h.result).toBe(0);
    expect(h.stderr).toBe('');
    expect(h.stdout).toContain('wrote out: 2 spans');
    expect(manifestOf(w, 'out').complete).toBe(true);
    const { spans, serviceOf } = chunkOf(w);
    expect(spans).toHaveLength(2);
    const root = spans.find((s) => s.parentSpanId === null);
    const child = spans.find((s) => s.name === 'child-work');
    expect(root?.name).toBe('node');
    expect(child?.traceId).toBe(root?.traceId);
    expect(child?.parentSpanId).toBe(root?.spanId);
    expect(root?.status.code ?? Status_StatusCode.UNSET).toBe(Status_StatusCode.UNSET);
    expect(root && serviceOf(root)).toEqual({ kind: 'string', value: 'node' });
  });

  test('two runs in one folder keep both root spans', async () => {
    const w = createTestWriter();
    for (let i = 0; i < 2; i++) {
      const h = start(w, ['run', '-o', 'out', ...node, '0']);
      open.push(h);
      expect(await h.result).toBe(0);
    }
    const { spans } = allChunks(w);
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
    const { spans } = allChunks(w);
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
  });

  test('a non-zero exit is the command exit code and the root span says so', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', ...node, '3']);
    open.push(h);
    expect(await h.result).toBe(3);
    const root = chunkOf(w).spans.find((s) => s.parentSpanId === null);
    expect(root?.status.code).toBe(Status_StatusCode.ERROR);
    expect(root?.status.message).toBe('exit code 3');
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

  test('SIGTERM is forwarded to the child: 143, killed by SIGTERM, report complete', async () => {
    const w = createTestWriter();
    const h = start(w, ['run', '-o', 'out', ...node, 'sleep']);
    open.push(h);
    await vi.waitFor(() => expect(h.child).toContain('ready'));
    h.fire('SIGTERM');
    expect(await h.result).toBe(143);
    const root = chunkOf(w).spans.find((s) => s.parentSpanId === null);
    expect(root?.status.message).toBe('killed by SIGTERM');
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
    expect(chunkOf(w).spans).toHaveLength(2);
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
    expect(await h.result).toBe(1);
    expect(h.stderr).toContain('EADDRINUSE');
    expect(h.stderr).toContain('--grpc');
  });
});

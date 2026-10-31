import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fromJsonString, toBinary } from '@bufbuild/protobuf';
import { credentials, makeGenericClientConstructor } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { ExportTraceServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { serviceDefinition } from '../../src/receiver/grpc.js';
import { serviceOf } from '../../src/receiver/signals.js';

// Runs only against a compiled binary: `OTEL_HTML_BINARY=dist/bin/otel-html-<target> vitest run test/cli/binary.test.ts`.
// A path that does not exist fails loudly instead of skipping.
const BINARY_ENV = 'OTEL_HTML_BINARY';
const binaryEnv = process.env[BINARY_ENV];
const exec = promisify(execFile);

interface Run {
  stdout: string;
  stderr: string;
}

/**
 * This process's environment without the trace context and OTLP settings an enclosing `otel-html run` exports (CI wraps
 * every step in one): a binary under test must neither join that trace nor see its endpoint, and must not rely on the
 * default ports (4317/4318) the outer receiver holds. `OTEL_HTML_*` stays.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const inherited =
      key === 'TRACEPARENT' ||
      key === 'TRACESTATE' ||
      (key.startsWith('OTEL_') && !key.startsWith('OTEL_HTML_'));
    if (!inherited) env[key] = value;
  }
  return env;
}

async function run(binary: string, args: readonly string[]): Promise<Run> {
  const { stdout, stderr } = await exec(binary, [...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: hermeticEnv(),
  });
  return { stdout, stderr };
}

// int64 fields near and beyond 2^53 (and nanosecond timestamps) must survive JSON.parse source access under Bun.
// Written as text: a JS number literal above 2^53 would already be rounded before it reached the binary.
const INT64_REQUEST =
  '{"resourceSpans":[{"resource":{},"scopeSpans":[{"scope":{},"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"big","kind":2,"startTimeUnixNano":1700000000000000001,"endTimeUnixNano":"1700000000000000999","attributes":[{"key":"big","value":{"intValue":9007199254740993}}]}]}]}]}';

const SPAN_REQUEST = (name: string, spanId: string): string =>
  `{"resourceSpans":[{"resource":{},"scopeSpans":[{"scope":{},"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"${spanId}","name":"${name}","kind":2,"startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000000000000999"}]}]}]}`;

interface Exited {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the binary; `until` resolves once stdout matches, then `drive` runs, then SIGINT and wait for exit. */
async function serveOnce(
  binary: string,
  args: readonly string[],
  until: RegExp,
  drive: (match: RegExpMatchArray) => Promise<void>,
): Promise<Exited> {
  const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: hermeticEnv() });
  let stdout = '';
  let stderr = '';
  let watchdog = false;
  const exited = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
  const ready = new Promise<RegExpMatchArray>((resolveReady, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      const m = stdout.match(until);
      if (m !== null) resolveReady(m);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.once('close', () =>
      reject(
        new Error(
          `${watchdog ? 'killed by the 50 s watchdog' : 'exited before listening'}; stdout: ${stdout}; stderr: ${stderr}`,
        ),
      ),
    );
  });
  const timer = setTimeout(() => {
    watchdog = true;
    child.kill('SIGKILL');
  }, 50_000);
  try {
    await drive(await ready);
    child.kill('SIGINT');
    const code = await exited;
    if (watchdog) throw new Error(`killed by the 50 s watchdog; stdout: ${stdout}; stderr: ${stderr}`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
  }
}

/** The OTLP/JSON request as protobuf; protobuf JSON carries bytes as base64, so the hex ids are re-encoded. */
function protobufRequest(json: string): Uint8Array {
  const base64 = json.replace(/"(traceId|spanId)":"([0-9a-f]+)"/g, (_, key: string, hex: string) => {
    return `"${key}":"${Buffer.from(hex, 'hex').toString('base64')}"`;
  });
  return toBinary(ExportTraceServiceRequestSchema, fromJsonString(ExportTraceServiceRequestSchema, base64));
}

async function exportOverGrpc(address: string, body: Uint8Array): Promise<void> {
  const Client = makeGenericClientConstructor(serviceDefinition(serviceOf('traces')), 'TraceService');
  const client = new Client(address, credentials.createInsecure());
  try {
    const exportFn: unknown = Reflect.get(client, 'Export');
    if (typeof exportFn !== 'function') throw new Error('client has no Export');
    await new Promise<void>((done, fail) => {
      Reflect.apply(exportFn, client, [body, (err: Error | null) => (err === null ? done() : fail(err))]);
    });
  } finally {
    client.close();
  }
}

describe.skipIf(binaryEnv === undefined)('compiled binary', () => {
  const binary = resolve(binaryEnv ?? '');
  let dir = '';

  beforeAll(async () => {
    expect(existsSync(binary), `OTEL_HTML_BINARY does not exist: ${binary}`).toBe(true);
    dir = await mkdtemp(join(tmpdir(), 'otel-html-binary-'));
  });
  afterAll(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  test('--version prints the package version', async () => {
    const { stdout } = await run(binary, ['--version']);
    expect(stdout.trim()).toBe(pkg.version);
  });

  test('converts the small fixture and ships the viewer byte-identical to dist/viewer', async () => {
    const out = join(dir, 'small');
    const { stdout } = await run(binary, ['convert', 'fixtures/small.otlp.json', '--out', out]);
    expect(stdout).toContain('wrote');
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    const names = await readdir(join(out, 'assets'));
    const scripts = names.filter((n) => /^viewer\.[A-Za-z0-9_-]+\.js$/.test(n));
    expect(scripts).toHaveLength(1);
    const script = scripts[0] ?? '';
    const [got, want] = await Promise.all([
      readFile(join(out, 'assets', script)),
      readFile(join('dist', 'viewer', 'assets', script)),
    ]);
    expect(got.equals(want)).toBe(true);
    for (const n of names.filter((x) => x.endsWith('.css'))) {
      const [a, b] = await Promise.all([
        readFile(join(out, 'assets', n)),
        readFile(join('dist', 'viewer', 'assets', n)),
      ]);
      expect(a.equals(b)).toBe(true);
    }
  });

  test('int64 values keep full precision (JSON.parse source access works under Bun)', async () => {
    const input = join(dir, 'big.otlp.json');
    const out = join(dir, 'big');
    await writeFile(input, INT64_REQUEST);
    await run(binary, ['convert', input, '--out', out]);
    const chunk = await readFile(join(out, 'data', 'chunks', 'spans', '000000.js'), 'utf8');
    expect(chunk).toContain('"9007199254740993"');
    expect(chunk).toContain('[998]');
  });

  test('serve receives OTLP over HTTP and gRPC and finishes on SIGINT', async () => {
    const out = join(dir, 'serve');
    const result = await serveOnce(
      binary,
      ['serve', '-o', out, '--http', '0', '--grpc', '0'],
      /listening on (\S+) \(OTLP\/HTTP\) and (\S+) \(OTLP\/gRPC\)/,
      async (m) => {
        const res = await fetch(`${m[1]}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: SPAN_REQUEST('over-http', 'aaaaaaaaaaaaaaaa'),
        });
        expect(res.status).toBe(200);
        await exportOverGrpc(m[2] ?? '', protobufRequest(SPAN_REQUEST('over-grpc', 'bbbbbbbbbbbbbbbb')));
      },
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const manifest = await readFile(join(out, 'data', 'manifest.js'), 'utf8');
    expect(manifest).toContain('"totals":{"spans":2,');
    const spans = await readFile(join(out, 'data', 'chunks', 'spans', '000000.js'), 'utf8');
    expect(spans).toContain('over-http');
    expect(spans).toContain('over-grpc');
  }, 60_000);

  test('a bad port is a usage error: exit 2, the reason on stderr, nothing on stdout', async () => {
    const failed = await exec(binary, ['serve', '-o', join(dir, 'bad-port'), '--http', '99999'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: hermeticEnv(),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failed).toMatchObject({ code: 2, stdout: '' });
    expect(String(Reflect.get(failed ?? {}, 'stderr'))).toContain('is not a port');
  }, 60_000);

  test('ci context writes a name-hashed TRACEPARENT to GITHUB_ENV and exits 0 with the API unreachable', async () => {
    const cwd = join(dir, 'ci-context');
    await mkdir(cwd, { recursive: true });
    const envFile = join(cwd, 'github-env');
    await writeFile(envFile, '');
    const { stdout } = await exec(binary, ['ci', 'context'], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd,
      env: {
        ...hermeticEnv(),
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_WORKFLOW: 'ci',
        GITHUB_REF_NAME: 'main',
        GITHUB_SHA: 'abc123',
        GITHUB_JOB: 'build',
        RUNNER_NAME: 'runner-1',
        GITHUB_TOKEN: 'x',
        GITHUB_API_URL: 'http://127.0.0.1:9',
        GITHUB_ENV: envFile,
      },
    });
    expect(await readFile(envFile, 'utf8')).toMatch(/^TRACEPARENT=00-[0-9a-f]{32}-[0-9a-f]{16}-01$/m);
    expect(stdout).toContain('::warning::');
  }, 60_000);

  test('run exits with the child code and records a root span', async () => {
    const out = join(dir, 'run');
    const code = await new Promise<number | null>((done, fail) => {
      const child = spawn(
        binary,
        ['run', '-o', out, '--http', '0', '--', process.execPath, '-e', 'process.exit(4)'],
        {
          stdio: 'ignore',
          env: hermeticEnv(),
          timeout: 50_000,
        },
      );
      child.once('error', fail);
      child.once('close', (exitCode, signal) =>
        signal === null ? done(exitCode) : fail(new Error(`run timed out after 50 s (${signal})`)),
      );
    });
    expect(code).toBe(4);
    const manifest = await readFile(join(out, 'data', 'manifest.js'), 'utf8');
    expect(manifest).toContain('"totals":{"spans":1,');
  }, 60_000);
});

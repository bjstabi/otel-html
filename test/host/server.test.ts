import { request } from 'node:http';
import { createServer } from 'node:net';
import { tableFromIPC } from 'apache-arrow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHostEngine } from '../../src/host/engine.js';
import { readHostManifest } from '../../src/host/manifest.js';
import {
  ARROW_STREAM_TYPE,
  HOST_META_CONTENT,
  MAX_QUERY_BODY_BYTES,
  QUERY_PATH,
  startHostServer,
} from '../../src/host/server.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { listenHttp } from '../../src/receiver/http.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { buildFormat4Report, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { packageHostEngineFiles } from '../../test-support/host-engine-files.js';
import { writeReportDir } from '../../test-support/report-dir.js';
import { createTestWriter, fakeViewerAssets } from '../../test-support/writer-deps.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function serve(bindHost = '127.0.0.1') {
  const fixture = await buildFormat4Report([spansOnlyRequest(3), spansOnlyRequest(2)], { close: false });
  const report = await writeReportDir(fixture);
  cleanups.push(report.close);
  const fs = createNodeFileSystem();
  const w = createTestWriter();
  const manifest = await readHostManifest(fs, report.dir);
  const engine = await startHostEngine({
    report: report.dir,
    manifest: fixture.manifest,
    files: packageHostEngineFiles(),
    fs,
    logger: w.deps.logger,
    timeoutMs: 30_000,
    maxResultBytes: 64 * 1024 * 1024,
  });
  cleanups.push(() => engine.close());
  const listener = await startHostServer({
    report: report.dir,
    manifest,
    engine,
    viewerAssets: fakeViewerAssets(),
    host: bindHost,
    port: 0,
    logger: w.deps.logger,
    tracer: w.deps.tracer,
  });
  cleanups.push(() => listener.close());
  return { base: listener.address, w };
}

const post = (base: string, body: string, path = QUERY_PATH) =>
  fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
const q = (base: string, sql: string, type = 'arrow') => post(base, JSON.stringify({ type, sql }));

describe('POST /query', () => {
  it('answers an arrow query as an IPC stream', async () => {
    const { base } = await serve();
    const res = await q(base, 'SELECT count(*) AS n FROM spans');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(ARROW_STREAM_TYPE);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const rows = tableFromIPC(new Uint8Array(await res.arrayBuffer())).toArray();
    expect(rows.map((r: { toJSON(): unknown }) => r.toJSON())).toEqual([{ n: 5n }]);
  });

  it('refuses non-arrow types, bad JSON, DDL and a big body, and recovers', async () => {
    const { base } = await serve();
    const exec = await q(base, 'CREATE TABLE t AS SELECT 1', 'exec');
    expect(exec.status).toBe(400);
    expect(await exec.text()).toContain('arrow');
    expect((await q(base, 'SELECT 1', 'json')).status).toBe(400);
    const ddl = await q(base, 'CREATE TABLE t AS SELECT 1');
    expect(ddl.status).toBe(400);
    expect(await ddl.text()).toContain('Parser Error');
    expect((await post(base, 'not json')).status).toBe(400);
    const big = await post(
      base,
      JSON.stringify({ type: 'arrow', sql: 'x'.repeat(2 * MAX_QUERY_BODY_BYTES) }),
    );
    expect(big.status).toBe(413);
    expect((await q(base, 'SELECT count(*) AS n FROM spans')).status).toBe(200);
  });

  it('is 405 for GET', async () => {
    const { base } = await serve();
    expect((await fetch(base + QUERY_PATH)).status).toBe(405);
  });

  it('records one host.query span per request', async () => {
    const { base, w } = await serve();
    await q(base, 'SELECT count(*) AS n FROM spans');
    await q(base, 'CREATE TABLE t AS SELECT 1');
    const spans = w.spans.filter((s) => s.name === 'host.query');
    expect(spans.map((s) => s.attrs['otel_html.status'])).toEqual([200, 400]);
    expect(spans[0]?.attrs['otel_html.result.bytes']).toBeGreaterThan(0);
    expect(spans.every((s) => s.ended)).toBe(true);
  });
});

describe('chunked bodies', () => {
  it('delivers the 413 for a body that exceeds the cap while streaming', async () => {
    const { base, w } = await serve();
    const url = new URL(base);
    const { connect } = await import('node:net');
    const raw = await new Promise<string>((resolve, reject) => {
      const s = connect(Number(url.port), url.hostname, () => {
        s.write(
          `POST /query HTTP/1.1\r\nhost: ${url.host}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n`,
        );
        const chunk = 'x'.repeat(64 * 1024);
        let i = 0;
        const timer = setInterval(() => {
          if (i++ >= 40 || s.destroyed) clearInterval(timer);
          else s.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
        }, 20);
        s.once('close', () => clearInterval(timer));
      });
      let out = '';
      s.on('data', (d) => {
        out += String(d);
      });
      s.on('error', (e) => (out.startsWith('HTTP/1.1') ? resolve(out) : reject(e)));
      s.on('close', () => resolve(out));
    });
    expect(raw.startsWith('HTTP/1.1 413')).toBe(true);
    const spans = w.spans.filter((x) => x.name === 'host.query');
    expect(spans.map((x) => x.attrs['otel_html.status'])).toEqual([413]);
  });
});

describe('static routes', () => {
  it('serves the shell, assets and manifest only', async () => {
    const { base } = await serve();
    for (const p of ['/', '/index.html']) {
      const res = await fetch(base + p);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain(`<meta name="otel-html-host" content="${HOST_META_CONTENT}">`);
      expect(html).toContain('assets/viewer.abc123.js');
    }
    const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const js = await fetch(`${base}/assets/viewer.abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    const man = await fetch(`${base}/data/manifest.js`);
    expect(man.headers.get('cache-control')).toBe('no-store');
    expect(await man.text()).toContain('__OH__.push("manifest"');
    expect((await fetch(`${base}/data/partitions/000000/spans.parquet`)).status).toBe(404);
    expect((await fetch(`${base}/assets/duckdb.1.32.0.wasm`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: 'PUT', body: 'x' })).status).toBe(405);
  });

  it('never leaves the asset map', async () => {
    const { base } = await serve();
    const url = new URL(base);
    for (const p of ['/../package.json', '/assets/..%2f..%2fpackage.json', '/%2e%2e/package.json']) {
      // fetch normalises dot segments, so send the raw request line too.
      expect((await fetch(base + p)).status).toBe(404);
      const raw = await new Promise<string>((resolve, reject) => {
        import('node:net').then(({ connect }) => {
          const s = connect(Number(url.port), url.hostname, () =>
            s.write(`GET ${p} HTTP/1.1\r\nhost: ${url.host}\r\nconnection: close\r\n\r\n`),
          );
          let out = '';
          s.on('data', (d) => {
            out += String(d);
          });
          s.on('error', reject);
          s.on('close', () => resolve(out));
        });
      });
      expect(raw.startsWith('HTTP/1.1 404')).toBe(true);
    }
  });
});

describe('listenHttp with --port', () => {
  it('names --port in the bind hint', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const addr = blocker.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const err = await listenHttp(() => {}, '127.0.0.1', port, '--port').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OtelHtmlError);
      expect(err).toMatchObject({ code: 'receiver-bind' });
      expect(String((err as OtelHtmlError).hint)).toContain('--port');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

/** A request with a chosen Host header (fetch does not allow one). */
function withHost(
  base: string,
  host: string,
  opts: { method?: string; path?: string; type?: string | undefined; body?: string | undefined } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: { host, ...(opts.type === undefined ? {} : { 'content-type': opts.type }) },
        agent: false,
      },
      (res) => {
        let text = '';
        res.on('data', (d) => {
          text += String(d);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('cross-site and rebound requests (I2)', () => {
  it('answers 415 to a query that is not application/json, and runs one that is', async () => {
    const { base } = await serve();
    const body = JSON.stringify({ type: 'arrow', sql: 'SELECT 1' });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const res = await withHost(base, new URL(base).host, { method: 'POST', path: QUERY_PATH, type, body });
      expect(res.status).toBe(415);
    }
    const ok = await withHost(base, new URL(base).host, {
      method: 'POST',
      path: QUERY_PATH,
      type: 'application/json; charset=utf-8',
      body,
    });
    expect(ok.status).toBe(200);
  });

  it('answers 403 to a foreign Host on a loopback bind, for every route', async () => {
    const { base } = await serve();
    const { port } = new URL(base);
    for (const host of [
      'evil.example',
      `evil.example:${port}`,
      '127.0.0.1',
      `127.0.0.1.evil.example:${port}`,
      `localhost:1`,
    ]) {
      for (const [method, path] of [
        ['GET', '/'],
        ['GET', '/data/manifest.js'],
        ['POST', QUERY_PATH],
        ['GET', '/nope'],
      ] as const) {
        const res = await withHost(base, host, {
          method,
          path,
          type: 'application/json',
          body: method === 'POST' ? JSON.stringify({ type: 'arrow', sql: 'SELECT 1' }) : undefined,
        });
        expect([host, path, res.status]).toEqual([host, path, 403]);
      }
    }
  });

  it('accepts the loopback names with the bound port', async () => {
    const { base } = await serve();
    const { port } = new URL(base);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
      expect([host, (await withHost(base, host)).status]).toEqual([host, 200]);
    }
  });

  it('accepts any Host when bound to a non-loopback address', async () => {
    const { base } = await serve('0.0.0.0');
    const { port } = new URL(base);
    const res = await withHost(`http://127.0.0.1:${port}/`, 'proxy.example', {});
    expect(res.status).toBe(200);
  });

  it('marks every response nosniff, the 404 that echoes the path included', async () => {
    const { base } = await serve();
    const host = new URL(base).host;
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/%3Cscript%3E'],
      ['GET', QUERY_PATH],
      ['PUT', '/'],
    ] as const) {
      const res = await withHost(base, host, { method, path });
      expect([path, res.headers['x-content-type-options']]).toEqual([path, 'nosniff']);
    }
    const refused = await withHost(base, 'evil.example');
    expect(refused.headers['x-content-type-options']).toBe('nosniff');
  });
});

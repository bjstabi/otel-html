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

async function serve() {
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
    host: '127.0.0.1',
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
      const raw = await new Promise<string>((resolve) => {
        import('node:net').then(({ connect }) => {
          const s = connect(Number(url.port), url.hostname, () =>
            s.write(`GET ${p} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`),
          );
          let out = '';
          s.on('data', (d) => {
            out += String(d);
          });
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

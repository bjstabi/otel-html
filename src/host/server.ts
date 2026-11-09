import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Listener, listenHttp } from '../receiver/http.js';
import { renderIndexHtml } from '../writer/html.js';
import type { Logger, SpanHandle, Tracer } from '../writer/ports.js';
import type { ViewerAssets } from '../writer/viewer-assets.js';
import { type HostEngine, HostError } from './engine.js';
import type { HostManifest } from './manifest.js';

export const QUERY_PATH = '/query';
/** The meta tag's value: the endpoint relative to index.html. */
export const HOST_META_CONTENT = 'query';
export const MAX_QUERY_BODY_BYTES = 1_048_576;
export const ARROW_STREAM_TYPE = 'application/vnd.apache.arrow.stream';

const MANIFEST_URL = '/data/manifest.js';
const ASSETS_PREFIX = '/assets/';
const SQL_LOG_CHARS = 200;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NON_ARROW = 'the host runs arrow queries only; its views are the schema';

export interface HostServerOptions {
  report: string;
  manifest: HostManifest;
  engine: HostEngine;
  viewerAssets: ViewerAssets;
  host: string;
  port: number;
  logger: Logger;
  tracer: Tracer;
}

const JS_TYPE = 'text/javascript; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';
const MIME: Readonly<Record<string, string>> = {
  js: JS_TYPE,
  css: 'text/css; charset=utf-8',
  html: HTML_TYPE,
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  wasm: 'application/wasm',
};

function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

class BodyTooLarge extends Error {}

/** The request body, counted against the cap while it streams; nothing past the cap is kept. */
async function readCapped(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > limit) throw new BodyTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

function parseQuery(text: string): { type: unknown; sql: unknown } | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    return { type: Reflect.get(v, 'type'), sql: Reflect.get(v, 'sql') };
  } catch {
    return undefined;
  }
}

/** The request handler alone, for tests and for the listener. */
export function hostHandler(
  opts: Omit<HostServerOptions, 'host' | 'port'>,
  assets: ReadonlyMap<string, Uint8Array>,
  shell: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { engine, logger, tracer } = opts;
  const manifestScript = opts.manifest.script;

  function send(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body: Uint8Array | string = '',
    after?: () => void,
  ): void {
    if (res.headersSent || res.writableEnded) return;
    const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
    res.writeHead(status, { ...headers, 'content-length': String(length) });
    res.end(req.method === 'HEAD' ? undefined : body, after);
  }

  const text = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    message: string,
    after?: () => void,
  ) =>
    send(
      req,
      res,
      status,
      { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      message,
      after,
    );

  async function query(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const span: SpanHandle = tracer.startSpan('host.query');
    let status = 500;
    try {
      let body: Buffer;
      try {
        body = await readCapped(req, MAX_QUERY_BODY_BYTES);
      } catch (e) {
        if (e instanceof BodyTooLarge) {
          status = 413;
          logger.warn('host query refused', { status, reason: 'body over the cap' });
          text(req, res, 413, `the request body exceeds ${MAX_QUERY_BODY_BYTES} bytes`, () => req.destroy());
          return;
        }
        status = 0; // the client went away
        logger.debug('host query aborted');
        return;
      }
      const parsed = parseQuery(body.toString('utf8'));
      if (parsed === undefined || typeof parsed.sql !== 'string') {
        status = 400;
        logger.warn('host query refused', { status, reason: 'not a JSON query request' });
        text(req, res, 400, 'the request body must be JSON: {"type":"arrow","sql":"..."}');
        return;
      }
      const sql = parsed.sql;
      span.setAttributes({ 'otel_html.sql.bytes': Buffer.byteLength(sql) });
      if (parsed.type !== 'arrow') {
        status = 400;
        logger.warn('host query refused', { status, sql: sql.slice(0, SQL_LOG_CHARS) });
        text(req, res, 400, NON_ARROW);
        return;
      }
      try {
        const bytes = await engine.query(sql);
        status = 200;
        span.setAttributes({ 'otel_html.result.bytes': bytes.length });
        send(req, res, 200, { 'content-type': ARROW_STREAM_TYPE, 'cache-control': 'no-store' }, bytes);
        logger.debug('host query', { status, resultBytes: bytes.length });
      } catch (e) {
        // The engine logs its own failed statements (D48); only the unexpected is logged here.
        if (e instanceof HostError) {
          status = e.status;
          span.recordError(e);
          text(req, res, e.status, e.message);
        } else {
          status = 500;
          span.recordError(e);
          logger.error('host query failed', { message: String(e) });
          text(req, res, 500, 'internal error');
        }
      }
    } finally {
      span.setAttributes({ 'otel_html.status': status });
      span.end();
    }
  }

  function serve(req: IncomingMessage, res: ServerResponse, path: string): void {
    const asset = path.startsWith(ASSETS_PREFIX) ? assets.get(path.slice(1)) : undefined;
    if (path === '/' || path === '/index.html') {
      send(req, res, 200, { 'content-type': HTML_TYPE, 'cache-control': 'no-store' }, shell);
    } else if (path === MANIFEST_URL) {
      send(req, res, 200, { 'content-type': JS_TYPE, 'cache-control': 'no-store' }, manifestScript);
    } else if (asset !== undefined) {
      send(req, res, 200, { 'content-type': mimeOf(path), 'cache-control': IMMUTABLE }, asset);
    } else {
      text(req, res, 404, `no such file: ${path}`);
    }
  }

  function dispatch(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> | undefined {
    const method = req.method ?? '';
    if (path === QUERY_PATH) {
      if (method === 'POST') return query(req, res);
      res.setHeader('allow', 'POST');
      text(req, res, 405, 'use POST');
    } else if (method === 'GET' || method === 'HEAD') {
      serve(req, res, path);
    } else {
      res.setHeader('allow', 'GET, HEAD');
      text(req, res, 405, `method ${method} is not allowed`);
    }
    return undefined;
  }

  return (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    Promise.resolve(dispatch(req, res, path)).catch((e: unknown) => {
      logger.error('host handler failed', { message: String(e) });
      if (res.headersSent) res.destroy();
      else text(req, res, 500, 'internal error');
    });
  };
}

/** Binds and serves (D39); `address` is `http://<host>:<port>`; close() stops the listener (the engine is the caller's). */
export async function startHostServer(opts: HostServerOptions): Promise<Listener> {
  const shell = renderIndexHtml(opts.viewerAssets.entry(), opts.manifest.manifest.title, {
    host: HOST_META_CONTENT,
  });
  const assets = new Map<string, Uint8Array>();
  for (const f of await opts.viewerAssets.files()) assets.set(f.path, f.contents);
  return listenHttp(hostHandler(opts, assets, shell), opts.host, opts.port, '--port');
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
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

const FALLBACK_TYPE = 'application/octet-stream';
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
  return Object.hasOwn(MIME, ext) ? (MIME[ext] ?? FALLBACK_TYPE) : FALLBACK_TYPE;
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

/** 127.0.0.0/8, `::1`: where a page on another site can still reach the host through the browser. */
function isLoopbackIp(ip: string): boolean {
  const kind = isIP(ip);
  return kind !== 0 && LOOPBACK.check(ip, kind === 4 ? 'ipv4' : 'ipv6');
}

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * The `Host` values a host bound to the loopback address `ip` answers to (DNS-rebinding guard); `null` accepts any
 * (bound elsewhere). `hostText` is what `--host` said: it is one more allowed name. Browsers leave the port out on 80.
 */
export function allowedHosts(ip: string, hostText: string, port: number): ReadonlySet<string> | null {
  if (!isLoopbackIp(ip)) return null;
  const bare = hostText.replace(/^\[|\]$/g, '');
  const names = [...LOOPBACK_NAMES, bare.includes(':') ? `[${bare}]` : bare].map((n) => n.toLowerCase());
  return new Set(names.flatMap((n) => (port === 80 ? [n, `${n}:${port}`] : [`${n}:${port}`])));
}

class BodyTooLarge extends Error {}

const DRAIN_GRACE_MS = 2_000;
const DRAIN_MAX_BYTES = 16 * 1_048_576;

/**
 * After a 413: read and discard the rest of the body so the client (on Windows especially) can read the response
 * before the connection closes; close when the request ends, after a grace, or past a further cap, so a client that
 * never stops sending cannot hold the socket.
 */
function drainThenClose(req: IncomingMessage, res: ServerResponse): void {
  let discarded = 0;
  const done = (): void => {
    clearTimeout(timer);
    req.destroy();
  };
  const timer = setTimeout(done, DRAIN_GRACE_MS);
  timer.unref();
  req.on('data', (c: Buffer) => {
    discarded += c.length;
    if (discarded > DRAIN_MAX_BYTES) done();
  });
  req.once('end', () => {
    if (res.writableFinished) done();
    else res.once('finish', done);
  });
  req.once('close', () => clearTimeout(timer));
  req.on('error', () => {});
  req.resume();
}

/** The request body, counted against the cap while it streams; nothing past the cap is kept. */
async function readCapped(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  // destroyOnReturn: false, so stopping at the cap leaves the socket for the 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
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
  allowed: () => ReadonlySet<string> | null = () => null,
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
    res.writeHead(status, {
      ...headers,
      'x-content-type-options': 'nosniff',
      'content-length': String(length),
    });
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
          logger.warn(`413 the request body exceeds ${MAX_QUERY_BODY_BYTES} bytes`);
          text(req, res, 413, `the request body exceeds ${MAX_QUERY_BODY_BYTES} bytes`);
          drainThenClose(req, res);
          return;
        }
        status = 0; // the client went away
        logger.debug('host query aborted');
        return;
      }
      const parsed = parseQuery(body.toString('utf8'));
      if (parsed === undefined || typeof parsed.sql !== 'string') {
        status = 400;
        logger.warn('400 the request body is not a JSON query request');
        text(req, res, 400, 'the request body must be JSON: {"type":"arrow","sql":"..."}');
        return;
      }
      const sql = parsed.sql;
      span.setAttributes({ 'otel_html.sql.bytes': Buffer.byteLength(sql) });
      if (parsed.type !== 'arrow') {
        status = 400;
        logger.warn(`400 ${NON_ARROW}: ${sql.slice(0, SQL_LOG_CHARS)}`);
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
      if (method === 'POST') {
        // Mosaic's connector always sends JSON; anything else is a "simple" cross-site request, which needs no preflight.
        if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
          const sent = (req.headers['content-type'] ?? '').slice(0, SQL_LOG_CHARS);
          logger.warn(`415 the request must be application/json${sent === '' ? '' : `: ${sent}`}`);
          text(req, res, 415, 'the request must be application/json');
          return undefined;
        }
        return query(req, res);
      }
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
    const hosts = allowed();
    if (hosts !== null && !hosts.has((req.headers.host ?? '').toLowerCase())) {
      logger.warn(
        `403 this host answers only to its own address: Host ${(req.headers.host ?? '').slice(0, SQL_LOG_CHARS)}`,
      );
      text(req, res, 403, 'this host answers only to its own address');
      return;
    }
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
  let hosts: ReadonlySet<string> | null = new Set();
  const listener = await listenHttp(
    hostHandler(opts, assets, shell, () => hosts),
    opts.host,
    opts.port,
    '--port',
  );
  hosts = allowedHosts(listener.ip ?? opts.host, opts.host, Number(new URL(listener.address).port));
  return listener;
}

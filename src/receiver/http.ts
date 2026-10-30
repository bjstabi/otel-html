import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGunzip } from 'node:zlib';
import { create, type DescMessage, type Message, toBinary, toJsonString } from '@bufbuild/protobuf';
import { StatusSchema } from '../model/gen/google/rpc/status_pb.js';
import type { Logger } from '../writer/ports.js';
import { bindError, bracketed } from './host.js';
import type { BodyEncoding, Receiver } from './receiver.js';
import { serviceAtPath } from './signals.js';
import {
  OUTCOME_STATUS,
  type Outcome,
  outcomeOf,
  RETRY_AFTER_SECONDS,
  ReceiverRejected,
  statusMessage,
} from './status.js';

/** Origins whose pages may call the receiver from a browser: localhost on any port, either scheme. */
export const CORS_ORIGIN: RegExp = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

const SOURCE = 'otlp/http';
const ALLOWED_METHODS = 'POST, OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type, Content-Encoding';
const PREFLIGHT_MAX_AGE_SECONDS = 600;
/** The status `code` of an outcome with no gRPC code (INVALID_ARGUMENT, as for a malformed request). */
const FALLBACK_STATUS_CODE = 3;

const CONTENT_TYPE: Readonly<Record<string, BodyEncoding>> = {
  'application/x-protobuf': 'protobuf',
  'application/json': 'json',
};
const MIME: Readonly<Record<BodyEncoding, string>> = {
  protobuf: 'application/x-protobuf',
  json: 'application/json',
};

export interface HttpTransportOptions {
  maxBodyBytes: number;
}

export interface Listener {
  readonly address: string;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

function encodingOf(req: IncomingMessage): BodyEncoding | undefined {
  const type = header(req, 'content-type')?.split(';')[0]?.trim().toLowerCase();
  return type === undefined ? undefined : CONTENT_TYPE[type];
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = header(req, 'origin');
  if (origin === undefined || !CORS_ORIGIN.test(origin)) return {};
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

function statusBody(encoding: BodyEncoding, outcome: Outcome, message: string): Uint8Array | string {
  const status = create(StatusSchema, {
    code: OUTCOME_STATUS[outcome].grpc ?? FALLBACK_STATUS_CODE,
    message,
  });
  return encoding === 'protobuf' ? toBinary(StatusSchema, status) : toJsonString(StatusSchema, status);
}

function responseBody(schema: DescMessage, encoding: BodyEncoding, message: Message): Uint8Array | string {
  return encoding === 'protobuf' ? toBinary(schema, message) : toJsonString(schema, message);
}

export function createHttpHandler(
  receiver: Receiver,
  options: HttpTransportOptions,
  logger: Logger,
): Handler {
  /** Writes the response and logs it. `after` runs once the response is flushed. */
  function send(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    status: number,
    headers: Record<string, string>,
    body: Uint8Array | string = '',
    after?: () => void,
  ): void {
    const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
    logger.debug('http request', { method: req.method, path, status, bytes: length });
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { ...corsHeaders(req), ...headers, 'content-length': String(length) });
    res.end(body, after);
  }

  function fail(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    encoding: BodyEncoding,
    e: unknown,
    after?: () => void,
  ): void {
    const outcome = outcomeOf(e);
    const spec = OUTCOME_STATUS[outcome];
    const headers: Record<string, string> = { 'content-type': MIME[encoding] };
    if (spec.retryable) headers['retry-after'] = String(RETRY_AFTER_SECONDS);
    if (spec.http >= 500 && outcome === 'internal')
      logger.error('http request failed', { path, message: String(e) });
    send(req, res, path, spec.http, headers, statusBody(encoding, outcome, statusMessage(e)), after);
  }

  /** A refusal that happens before `receive`: counted by the receiver, then answered. */
  function refuse(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    encoding: BodyEncoding,
    e: ReceiverRejected,
    after?: () => void,
  ): void {
    receiver.refused(e.outcome, e.message);
    fail(req, res, path, encoding, e, after);
  }

  /**
   * The inflated body, counted against the limit while it streams. The request is piped, not `pipeline`d, so that
   * stopping early (over the limit, a corrupt stream) leaves the socket for the response.
   */
  async function readBody(req: IncomingMessage, gzip: boolean): Promise<Uint8Array> {
    const limit = options.maxBodyBytes;
    const gunzip = gzip ? createGunzip() : null;
    let source: AsyncIterable<unknown> = req;
    if (gunzip !== null) {
      req.once('error', (e) => gunzip.destroy(e));
      req.once('close', () => {
        if (!req.complete) {
          gunzip.destroy(Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
        }
      });
      source = req.pipe(gunzip);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of source) {
        const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        total += buf.length;
        if (total > limit) {
          throw new ReceiverRejected('too-large', `request body exceeds the limit of ${limit} bytes`);
        }
        chunks.push(buf);
      }
    } finally {
      if (gunzip !== null) {
        req.unpipe(gunzip);
        gunzip.destroy();
        req.resume(); // drain what is left so the response can be sent
      }
    }
    return Buffer.concat(chunks, total);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const service = serviceAtPath(path);
    if (service === undefined) {
      return refuse(req, res, path, 'json', new ReceiverRejected('not-found', `no such endpoint: ${path}`));
    }
    if (req.method === 'OPTIONS') {
      const requested = header(req, 'access-control-request-headers');
      const cors = corsHeaders(req);
      const preflight =
        cors['access-control-allow-origin'] === undefined
          ? {}
          : {
              ...cors,
              vary: 'Origin, Access-Control-Request-Headers',
              'access-control-allow-methods': 'POST',
              'access-control-allow-headers': requested ?? DEFAULT_ALLOWED_HEADERS,
              'access-control-max-age': String(PREFLIGHT_MAX_AGE_SECONDS),
            };
      return send(req, res, path, 204, { allow: ALLOWED_METHODS, ...preflight });
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', ALLOWED_METHODS);
      return refuse(
        req,
        res,
        path,
        'json',
        new ReceiverRejected('method', `method ${req.method ?? ''} is not allowed; use POST`),
      );
    }
    const encoding = encodingOf(req);
    if (encoding === undefined) {
      return refuse(
        req,
        res,
        path,
        'json',
        new ReceiverRejected(
          'unsupported',
          `unsupported content-type ${header(req, 'content-type') ?? '(none)'}; use application/x-protobuf or application/json`,
        ),
      );
    }
    const contentEncoding = header(req, 'content-encoding')?.trim().toLowerCase();
    if (contentEncoding !== undefined && contentEncoding !== 'gzip' && contentEncoding !== 'identity') {
      return refuse(
        req,
        res,
        path,
        encoding,
        new ReceiverRejected(
          'unsupported',
          `unsupported content-encoding ${contentEncoding}; use gzip or none`,
        ),
      );
    }
    const declared = Number(header(req, 'content-length'));
    const closeRequest = () => req.destroy();
    if (declared > options.maxBodyBytes) {
      return refuse(
        req,
        res,
        path,
        encoding,
        new ReceiverRejected(
          'too-large',
          `request body of ${declared} bytes exceeds the limit of ${options.maxBodyBytes} bytes`,
        ),
        closeRequest,
      );
    }
    let body: Uint8Array;
    try {
      body = await readBody(req, contentEncoding === 'gzip');
    } catch (e) {
      if (e instanceof ReceiverRejected) return refuse(req, res, path, encoding, e, closeRequest);
      if (clientGone(e)) {
        logger.debug('http request aborted', { path });
        return;
      }
      return refuse(
        req,
        res,
        path,
        encoding,
        new ReceiverRejected(
          'invalid',
          `cannot read the request body: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
    try {
      const result = await receiver.receive(service.signal, body, encoding, SOURCE);
      const response = service.respond(result.accepted, result.rejected, result.errorMessage);
      send(
        req,
        res,
        path,
        200,
        { 'content-type': MIME[encoding] },
        responseBody(service.response, encoding, response),
      );
    } catch (e) {
      fail(req, res, path, encoding, e);
    }
  }

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      logger.error('http handler failed', { message: String(e) });
      if (!res.headersSent) fail(req, res, req.url ?? '', 'json', e);
      else res.destroy();
    });
  };
}

/** The client went away mid-upload (as opposed to sending a body that cannot be read). */
function clientGone(e: unknown): boolean {
  const code = e instanceof Error ? Reflect.get(e, 'code') : undefined;
  return code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

/** Binds `handler`; `address` is `http://<host>:<port>` with the port actually bound. */
export function listenHttp(handler: Handler, host: string, port: number): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(handler);
    const onError = (e: Error): void => reject(bindError(e, '--http'));
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('invariant violated: http server has no address'));
        return;
      }
      const { port: actual }: AddressInfo = bound;
      resolve({
        address: `http://${bracketed(host)}:${actual}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err === undefined ? done() : fail(err)));
            server.closeIdleConnections();
          }),
      });
    });
  });
}

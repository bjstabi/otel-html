import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.parquet': 'application/vnd.apache.parquet',
  '.wasm': 'application/wasm',
};

/** A single `bytes=a-b` or `bytes=a-` range of a file of `size` bytes; `null` when absent or not understood. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  // `bytes=-n` is the last n bytes (RFC 9110). A multi-range request is answered with the whole file (200), which
  // the RFC allows.
  const suffix = /^bytes=-(\d+)$/.exec(header ?? '');
  if (suffix !== null) {
    const n = Number(suffix[1]);
    return n === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (m === null) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || end < start ? 'unsatisfiable' : { start, end };
}

/**
 * Serves folders over HTTP on a free loopback port: each mount's files appear under its URL prefix. Answers `Range`
 * (a single range, 206 or 416) and `HEAD`; HEAD never carries `Content-Range`, as on GitHub Pages (spec §12).
 * `requests()` lists every request path in arrival order. The server also answers `GET /__requests` with every request
 * seen so far as JSON (`RequestRecord[]`: path and `Range` header, the endpoint's own requests left out), so a test
 * worker, which runs in another process than global setup's server, can read what its page asked for.
 */
export interface RequestRecord {
  path: string;
  /** The `Range` header as sent, or `null`. */
  range: string | null;
}

/** The reserved path under which the server lists the requests it has seen. */
export const REQUESTS_PATH = '/__requests';

export async function serve(mounts: readonly { prefix: string; root: string }[]): Promise<{
  port: number;
  requests(): readonly string[];
  close(): Promise<void>;
}> {
  const seen: RequestRecord[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = decodeURIComponent(url.pathname);
    if (rel === REQUESTS_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seen));
      return;
    }
    seen.push({ path: rel, range: req.headers.range ?? null });
    const head = req.method === 'HEAD';
    const mount = mounts.find((m) => rel.startsWith(`${m.prefix}/`));
    const file = mount === undefined ? null : normalize(join(mount.root, rel.slice(mount.prefix.length)));
    if (mount === undefined || file === null || !file.startsWith(mount.root + sep)) {
      res.writeHead(404).end();
      return;
    }
    stat(file).then(
      (s) => {
        if (!s.isFile()) {
          res.writeHead(404).end();
          return;
        }
        const base = {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'accept-ranges': 'bytes',
        };
        const range = head ? null : parseRange(req.headers.range, s.size);
        if (range === 'unsatisfiable') {
          res.writeHead(416, { ...base, 'content-range': `bytes */${s.size}`, 'content-length': 0 }).end();
        } else if (range === null) {
          res.writeHead(200, { ...base, 'content-length': s.size });
          if (head) res.end();
          else createReadStream(file).pipe(res);
        } else {
          res.writeHead(206, {
            ...base,
            'content-range': `bytes ${range.start}-${range.end}/${s.size}`,
            'content-length': range.end - range.start + 1,
          });
          createReadStream(file, range).pipe(res);
        }
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('static server has no TCP address');
  const { port } = address;
  return {
    port,
    requests: () => seen.map((r) => r.path),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

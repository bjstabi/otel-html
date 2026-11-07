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
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (m === null) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || end < start ? 'unsatisfiable' : { start, end };
}

/**
 * Serves folders over HTTP on a free loopback port: each mount's files appear under its URL prefix. Answers `Range`
 * (a single range, 206 or 416) and `HEAD`; HEAD never carries `Content-Range`, as on GitHub Pages (spec §12).
 * `requests()` lists every request path in arrival order.
 */
export async function serve(mounts: readonly { prefix: string; root: string }[]): Promise<{
  port: number;
  requests(): readonly string[];
  close(): Promise<void>;
}> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = decodeURIComponent(url.pathname);
    seen.push(rel);
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
  return { port, requests: () => seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

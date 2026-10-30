import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Serves folders over HTTP on a free loopback port: each mount's files appear under its URL prefix. */
export async function serve(
  mounts: readonly { prefix: string; root: string }[],
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = decodeURIComponent(url.pathname);
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
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        createReadStream(file).pipe(res);
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
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

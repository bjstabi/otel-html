import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  HOSTILE_SPAN_NAME,
  HTTP_SUBPATH,
  PORT_ENV,
  REPORT_DIR,
  REPORTS_DIR,
  RUN_TITLE,
  SERVICE_A,
  SERVICE_B,
} from './fixture.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const str = (key: string, value: string): { key: string; value: { stringValue: string } } => ({
  key,
  value: { stringValue: value },
});

/** A tiny OTLP/JSON input: two traces over two services, 6 spans of which 2 error, a hostile span name, one log, one metric. */
function otlpInputs(): Record<string, unknown> {
  const t0 = 1_700_000_000_000_000_000n;
  const span = (
    traceId: string,
    spanId: string,
    name: string,
    offsetMs: number,
    parent?: string,
    error = false,
  ) => ({
    traceId,
    spanId,
    ...(parent === undefined ? {} : { parentSpanId: parent }),
    name,
    kind: 2,
    startTimeUnixNano: String(t0 + BigInt(offsetMs) * 1_000_000n),
    endTimeUnixNano: String(t0 + BigInt(offsetMs + 40) * 1_000_000n),
    ...(error ? { status: { code: 2, message: 'boom' } } : {}),
  });
  const resource = { attributes: [str('service.name', SERVICE_A)] };
  const dbResource = { attributes: [str('service.name', SERVICE_B)] };
  const scope = { name: 'e2e' };
  const trace1 = '0102030405060708090a0b0c0d0e0f10';
  const trace2 = '1102030405060708090a0b0c0d0e0f10';
  return {
    'traces.json': {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope,
              spans: [
                span(trace1, '0102030405060708', 'GET /root', 0),
                span(trace2, '0302030405060708', HOSTILE_SPAN_NAME, 100),
                span(trace2, '0602030405060708', 'GET /health', 200),
              ],
            },
          ],
        },
        {
          resource: dbResource,
          scopeSpans: [
            {
              scope,
              spans: [
                span(trace1, '0202030405060708', 'db.query', 5, '0102030405060708', true),
                span(trace1, '0402030405060708', 'db.commit', 20, '0102030405060708'),
                span(trace2, '0502030405060708', 'db.timeout', 110, '0302030405060708', true),
              ],
            },
          ],
        },
      ],
    },
    'logs.json': {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope,
              logRecords: [
                {
                  timeUnixNano: String(t0 + 10_000_000n),
                  severityNumber: 9,
                  body: { stringValue: 'hello' },
                  traceId: trace1,
                  spanId: '0102030405060708',
                },
              ],
            },
          ],
        },
      ],
    },
    'metrics.json': {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope,
              metrics: [
                {
                  name: 'requests',
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [{ timeUnixNano: String(t0 + 20_000_000n), asInt: '3' }],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

async function buildReport(): Promise<void> {
  await rm(REPORTS_DIR, { recursive: true, force: true });
  const inputs = new URL('inputs/', REPORTS_DIR);
  await mkdir(inputs, { recursive: true });
  const files: string[] = [];
  for (const [name, body] of Object.entries(otlpInputs())) {
    const path = fileURLToPath(new URL(name, inputs));
    await writeFile(path, JSON.stringify(body));
    files.push(path);
  }
  await run(process.execPath, [
    CLI,
    'convert',
    ...files,
    '--out',
    fileURLToPath(REPORT_DIR),
    '--title',
    RUN_TITLE,
  ]);
}

async function serve(root: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = decodeURIComponent(url.pathname);
    const file = rel.startsWith(`${HTTP_SUBPATH}/`)
      ? normalize(join(root, rel.slice(HTTP_SUBPATH.length)))
      : null;
    if (file === null || !file.startsWith(root + sep)) {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('static server has no TCP address');
  const { port } = address;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await buildReport();
  const server = await serve(fileURLToPath(REPORT_DIR).replace(/\/$/, ''));
  process.env[PORT_ENV] = String(server.port);
  return () => server.close();
}

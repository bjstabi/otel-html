import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  backendIds,
  MAX_UPLOAD_BYTES,
  uploadArtifact,
  zipDirectory,
} from '../../../src/cli/ci/artifact-client.js';
import { readZip } from '../../../src/cli/ci/zip.js';
import { OtelHtmlError } from '../../../src/model/errors.js';
import { createMemoryFileSystem } from '../../../test-support/memory-fs.js';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (scp: string): string => `${b64({ alg: 'none' })}.${b64({ scp })}.sig`;
const TOKEN = jwt('Actions.GenericRead:00000000 Actions.Results:run-id:job-id');
const TWIRP = '/twirp/github.actions.results.api.v1.ArtifactService/';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server;
let origin: string;
let seen: Seen[];
let statuses: number[];

beforeEach(async () => {
  seen = [];
  statuses = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const status = statuses.shift() ?? 200;
      if (status !== 200) {
        res.writeHead(status).end('nope');
        return;
      }
      const url = req.url ?? '';
      if (url === `${TWIRP}CreateArtifact`)
        res.end(JSON.stringify({ ok: true, signedUploadUrl: `${origin}/blob/x?sig=1` }));
      else if (url.startsWith('/blob/')) res.writeHead(201).end();
      else if (url === `${TWIRP}FinalizeArtifact`) res.end(JSON.stringify({ ok: true, artifactId: '77' }));
      else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const zip = new TextEncoder().encode('not really a zip, but bytes');
const env = (): { ACTIONS_RUNTIME_TOKEN: string; ACTIONS_RESULTS_URL: string } => ({
  ACTIONS_RUNTIME_TOKEN: TOKEN,
  ACTIONS_RESULTS_URL: origin,
});
const upload = (extra: Partial<Parameters<typeof uploadArtifact>[0]> = {}) =>
  uploadArtifact({
    name: 'n',
    zip,
    env: env(),
    now: () => Date.UTC(2026, 0, 1),
    sleep: async () => {},
    ...extra,
  });

describe('backendIds', () => {
  test('reads both ids from the Actions.Results scope', () => {
    expect(backendIds(TOKEN)).toEqual({ workflowRunBackendId: 'run-id', workflowJobRunBackendId: 'job-id' });
  });
  test('rejects usage without the scope or on a malformed token', () => {
    for (const t of [jwt('Actions.GenericRead:0'), 'garbage', `a.${b64({})}.c`]) {
      expect(() => backendIds(t)).toThrow(OtelHtmlError);
      try {
        backendIds(t);
      } catch (e) {
        expect((e as OtelHtmlError).code).toBe('usage');
      }
    }
  });
});

describe('uploadArtifact', () => {
  test('Create, PUT, Finalize with the documented bodies', async () => {
    const r = await upload();
    expect(r).toEqual({ id: 77, size: zip.length });
    expect(seen.map((s) => `${s.method} ${s.url.split('?')[0]}`)).toEqual([
      `POST ${TWIRP}CreateArtifact`,
      'PUT /blob/x',
      `POST ${TWIRP}FinalizeArtifact`,
    ]);
    const [create, put, fin] = seen as [Seen, Seen, Seen];
    expect(create.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const c = JSON.parse(create.body.toString());
    expect(c).toMatchObject({
      workflowRunBackendId: 'run-id',
      workflowJobRunBackendId: 'job-id',
      name: 'n',
      mimeType: { value: 'application/zip' },
    });
    expect(typeof c.version).toBe('number');
    expect(c.expiresAt).toBeUndefined();
    expect(put.headers['x-ms-blob-type']).toBe('BlockBlob');
    expect(put.headers['x-ms-blob-content-type']).toBe('application/zip');
    expect(put.body.length).toBe(zip.length);
    expect(put.headers.authorization).toBeUndefined();
    expect(JSON.parse(fin.body.toString())).toMatchObject({
      workflowRunBackendId: 'run-id',
      workflowJobRunBackendId: 'job-id',
      name: 'n',
      size: String(zip.length),
      hash: { value: `sha256:${createHash('sha256').update(zip).digest('hex')}` },
    });
  });

  test('retentionDays sets expiresAt as RFC 3339', async () => {
    await upload({ retentionDays: 2 });
    expect(JSON.parse((seen[0] as Seen).body.toString()).expiresAt).toBe('2026-01-03T00:00:00.000Z');
  });

  test('a 503 then success backs off once', async () => {
    statuses = [503];
    const slept: number[] = [];
    const r = await upload({ sleep: async (ms) => void slept.push(ms) });
    expect(r.id).toBe(77);
    expect(slept).toEqual([1000]);
  });

  test('backoff doubles and gives up after five retries', async () => {
    statuses = [429, 500, 502, 503, 504, 503];
    const slept: number[] = [];
    await expect(upload({ sleep: async (ms) => void slept.push(ms) })).rejects.toThrow(/503/);
    expect(slept).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  test('a 400 rejects at once', async () => {
    statuses = [400];
    const slept: number[] = [];
    await expect(upload({ sleep: async (ms) => void slept.push(ms) })).rejects.toThrow(/400/);
    expect(slept).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  test('a body with ok false rejects', async () => {
    await expect(
      upload({ fetchFn: async () => new Response(JSON.stringify({ ok: false })) }),
    ).rejects.toThrow(/ok: false/);
  });

  test('over MAX_UPLOAD_BYTES rejects usage without a request', async () => {
    const big = { length: MAX_UPLOAD_BYTES + 1 } as unknown as Uint8Array;
    await expect(upload({ zip: big })).rejects.toMatchObject({ code: 'usage' });
    expect(seen).toHaveLength(0);
  });

  test('missing runtime variables are usage', async () => {
    await expect(upload({ env: {} })).rejects.toMatchObject({ code: 'usage' });
  });
});

describe('zipDirectory', () => {
  test('zips files recursively with slash names', async () => {
    const fs = createMemoryFileSystem();
    await fs.mkdirp('/w/d/sub');
    await fs.writeBytes('/w/d/a.txt', new Uint8Array([1]));
    await fs.writeBytes('/w/d/sub/b.txt', new Uint8Array([2, 3]));
    const m = readZip(await zipDirectory(fs, '/w/d'), 1000);
    expect([...m.keys()].sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect([...(m.get('sub/b.txt') ?? [])]).toEqual([2, 3]);
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serve } from '../../e2e/static-server.js';

let dir = '';
let server: Awaited<ReturnType<typeof serve>>;
const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'static-server-'));
  await writeFile(join(dir, 'a.parquet'), bytes);
  await writeFile(join(dir, 'e.wasm'), bytes);
  server = await serve([{ prefix: '/m', root: dir }]);
});
afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${path}`, init);

it('answers a full GET with Accept-Ranges and Content-Length', async () => {
  const res = await get('/m/a.parquet');
  expect(res.status).toBe(200);
  expect(res.headers.get('accept-ranges')).toBe('bytes');
  expect(res.headers.get('content-length')).toBe('100');
  expect(res.headers.get('content-type')).toBe('application/vnd.apache.parquet');
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
});

it('serves a closed range with 206 and the right bytes', async () => {
  const res = await get('/m/a.parquet', { headers: { range: 'bytes=10-19' } });
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe('bytes 10-19/100');
  expect(res.headers.get('content-length')).toBe('10');
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(10, 20));
});

it('serves an open range, and clamps an end past the file', async () => {
  const open = await get('/m/a.parquet', { headers: { range: 'bytes=90-' } });
  expect(open.status).toBe(206);
  expect(open.headers.get('content-range')).toBe('bytes 90-99/100');
  expect(new Uint8Array(await open.arrayBuffer())).toEqual(bytes.slice(90));
  const clamped = await get('/m/a.parquet', { headers: { range: 'bytes=95-500' } });
  expect(clamped.headers.get('content-range')).toBe('bytes 95-99/100');
});

it('serves a suffix range as the last n bytes, and a multi-range as the whole file', async () => {
  const tail = await get('/m/a.parquet', { headers: { range: 'bytes=-10' } });
  expect(tail.status).toBe(206);
  expect(tail.headers.get('content-range')).toBe('bytes 90-99/100');
  expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(90));
  expect((await get('/m/a.parquet', { headers: { range: 'bytes=-500' } })).headers.get('content-range')).toBe(
    'bytes 0-99/100',
  );
  const multi = await get('/m/a.parquet', { headers: { range: 'bytes=0-1,5-6' } });
  expect(multi.status).toBe(200);
});

it('answers an unsatisfiable range with 416 and the size', async () => {
  const res = await get('/m/a.parquet', { headers: { range: 'bytes=100-' } });
  expect(res.status).toBe(416);
  expect(res.headers.get('content-range')).toBe('bytes */100');
});

it('answers HEAD with 200, Content-Length, no body and no Content-Range, even with Range', async () => {
  const res = await get('/m/a.parquet', { method: 'HEAD', headers: { range: 'bytes=0-9' } });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-length')).toBe('100');
  expect(res.headers.get('content-range')).toBeNull();
  expect(await res.text()).toBe('');
});

it('types .wasm, 404s unknown paths and records every request path', async () => {
  expect((await get('/m/e.wasm')).headers.get('content-type')).toBe('application/wasm');
  expect((await get('/m/missing')).status).toBe(404);
  expect((await get('/other')).status).toBe(404);
  expect(server.requests()).toContain('/m/e.wasm');
  expect(server.requests()).toContain('/m/missing');
});

it('lists the requests with their Range headers at /__requests, leaving its own request out', async () => {
  await get('/m/a.parquet', { headers: { range: 'bytes=0-9' } });
  await get('/m/e.wasm');
  const body = (await (await get('/__requests')).json()) as { path: string; range: string | null }[];
  expect(body.slice(-2)).toEqual([
    { path: '/m/a.parquet', range: 'bytes=0-9' },
    { path: '/m/e.wasm', range: null },
  ]);
  expect(server.requests()).not.toContain('/__requests');
});

import { gzipSync } from 'node:zlib';
import { beforeEach, expect, test, vi } from 'vitest';
import { ENGINE_WASM_KEY, ENGINE_WORKER_KEY } from '../../src/format/engine.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { toBase64 } from '../../src/viewer/data/engine/bytes.js';
import { type EngineDeps, engineUrls, startEngine } from '../../src/viewer/data/engine/start.js';
import type { ScriptLoader } from '../../src/viewer/data/script-loader.js';

const fake = vi.hoisted(() => ({
  instantiated: [] as string[],
  opened: [] as unknown[],
  events: [] as string[],
  failInstantiate: false,
  failOpen: false,
  failConnect: false,
}));

vi.mock('@duckdb/duckdb-wasm', () => ({
  VoidLogger: class {},
  AsyncDuckDB: class {
    async instantiate(url: string): Promise<void> {
      if (fake.failInstantiate) throw new Error('boom');
      fake.instantiated.push(url);
    }
    async open(config: unknown): Promise<void> {
      if (fake.failOpen) throw new Error('open failed');
      fake.opened.push(config);
    }
    async connect(): Promise<{ close(): Promise<void> }> {
      if (fake.failConnect) throw new Error('connect failed');
      return {
        close: async () => {
          fake.events.push('connection.close');
        },
      };
    }
    async registerFileText(name: string, text: string): Promise<void> {
      fake.events.push(`register:${name}:${text}`);
    }
    async terminate(): Promise<void> {
      fake.events.push('db.terminate');
    }
  },
}));

beforeEach(() => {
  fake.instantiated.length = 0;
  fake.opened.length = 0;
  fake.events.length = 0;
});

const localEngine = { version: '1.32.0', format: 'local', assetsBase: 'assets/' } as const;
const siteEngine = { version: '1.32.0', format: 'site', assetsBase: 'assets/' } as const;

function scriptedLoader(payloads: Record<string, string>): ScriptLoader {
  return { load: async (_path, key) => payloads[key] };
}

function fakeWorker(): Worker {
  return {} as Worker;
}

function deps(loader: ScriptLoader, created: string[] = [], revoked: string[] = []): EngineDeps {
  return {
    loader,
    baseUrl: 'file:///r/index.html',
    createWorker: (u) => {
      created.push(u);
      fake.events.push('createWorker');
      return fakeWorker();
    },
    blobUrl: {
      create: () => 'blob:fake-1',
      revoke: (u) => {
        revoked.push(u);
        fake.events.push('revoke');
      },
    },
  };
}

test('engineUrls resolves the two files under assetsBase for each format', () => {
  const base = 'https://x.test/site/branch/main/index.html';
  expect(engineUrls({ version: '1.32.0', format: 'site', assetsBase: '../../assets/0.3.0/' }, base)).toEqual({
    wasm: 'https://x.test/site/assets/0.3.0/duckdb.1.32.0.wasm',
    worker: 'https://x.test/site/assets/0.3.0/duckdb.1.32.0.worker.js',
  });
  expect(engineUrls(localEngine, 'file:///r/index.html').wasm).toBe(
    'file:///r/assets/duckdb.1.32.0.wasm.gz.b64.js',
  );
});

test('local start gunzips the wrapper into a data: URL and makes the worker from a blob URL', async () => {
  const loader = scriptedLoader({
    [ENGINE_WASM_KEY]: toBase64(gzipSync(Buffer.from('WASM'))),
    [ENGINE_WORKER_KEY]: toBase64(Buffer.from('self.x=1')),
  });
  const created: string[] = [];
  const revoked: string[] = [];
  const engine = await startEngine(localEngine, deps(loader, created, revoked));
  expect(fake.instantiated[0]).toBe(`data:application/wasm;base64,${toBase64(Buffer.from('WASM'))}`);
  expect(created[0]).toMatch(/^blob:/);
  expect(revoked).toEqual(['blob:fake-1']);
  expect(engine.format).toBe('local');
});

test('site start uses plain URLs and enables range reads', async () => {
  const created: string[] = [];
  const load = vi.fn();
  const engine = await startEngine(siteEngine, deps({ load }, created));
  expect(load).not.toHaveBeenCalled();
  expect(created).toEqual(['file:///r/assets/duckdb.1.32.0.worker.js']);
  expect(fake.instantiated).toEqual(['file:///r/assets/duckdb.1.32.0.wasm']);
  expect(fake.opened).toEqual([{ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true } }]);
  expect(engine.format).toBe('site');
});

test('registerText and close reach the database and connection', async () => {
  const engine = await startEngine(siteEngine, deps({ load: vi.fn() }));
  await engine.registerText('ids.csv', 'a,b');
  await engine.close();
  expect(fake.events).toContain('register:ids.csv:a,b');
  expect(fake.events.slice(-2)).toEqual(['connection.close', 'db.terminate']);
});

test.each([
  ['wasm', 'file:///r/assets/duckdb.1.32.0.wasm.gz.b64.js'],
  ['worker', 'file:///r/assets/duckdb.1.32.0.worker.b64.js'],
])('a missing %s wrapper fails with its file name', async (which, url) => {
  const requested: string[] = [];
  const loader: ScriptLoader = {
    load: async (path, key) => {
      requested.push(path);
      if (path === url) throw new OtelHtmlError('invalid-report', { path, actual: 'missing' });
      return key === ENGINE_WASM_KEY ? toBase64(gzipSync(Buffer.from('WASM'))) : toBase64(Buffer.from('x'));
    },
  };
  await expect(startEngine(localEngine, deps(loader))).rejects.toMatchObject({
    code: 'invalid-report',
    path: url,
  });
  expect(requested).toContain(url);
  expect(which).toBeTruthy();
});

const localLoader = (): ScriptLoader =>
  scriptedLoader({
    [ENGINE_WASM_KEY]: toBase64(gzipSync(Buffer.from('WASM'))),
    [ENGINE_WORKER_KEY]: toBase64(Buffer.from('self.x=1')),
  });

test('the blob URL is revoked when createWorker throws', async () => {
  const revoked: string[] = [];
  const d = deps(localLoader(), [], revoked);
  d.createWorker = () => {
    throw new Error('no worker');
  };
  await expect(startEngine(localEngine, d)).rejects.toThrow('no worker');
  expect(revoked).toEqual(['blob:fake-1']);
});

test('instantiate failure revokes the blob URL and terminates the database', async () => {
  const revoked: string[] = [];
  fake.failInstantiate = true;
  try {
    await expect(startEngine(localEngine, deps(localLoader(), [], revoked))).rejects.toThrow('boom');
  } finally {
    fake.failInstantiate = false;
  }
  expect(revoked).toEqual(['blob:fake-1']);
  expect(fake.events).toContain('db.terminate');
});

test('a non-string wrapper payload is an invalid-report naming the file', async () => {
  const loader: ScriptLoader = { load: async () => 42 };
  await expect(startEngine(localEngine, deps(loader))).rejects.toMatchObject({
    code: 'invalid-report',
    path: 'file:///r/assets/duckdb.1.32.0.wasm.gz.b64.js',
  });
});

test.each([
  ['site', 'open', siteEngine],
  ['site', 'instantiate', siteEngine],
  ['site', 'connect', siteEngine],
  ['local', 'connect', localEngine],
] as const)('%s start: a failed %s terminates the database', async (_format, step, engineSpec) => {
  const flag = { open: 'failOpen', instantiate: 'failInstantiate', connect: 'failConnect' }[step] as
    | 'failOpen'
    | 'failInstantiate'
    | 'failConnect';
  fake[flag] = true;
  try {
    await expect(startEngine(engineSpec, deps(localLoader()))).rejects.toThrow();
  } finally {
    fake[flag] = false;
  }
  expect(fake.events).toContain('db.terminate');
});

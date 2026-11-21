import { gzipSync } from 'node:zlib';
import { beforeEach, expect, test, vi } from 'vitest';
import { ENGINE_WASM_KEY, ENGINE_WORKER_KEY, engineExtensionKey } from '../../src/format/engine.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { toBase64 } from '../../src/viewer/data/engine/bytes.js';
import {
  type EngineDeps,
  engineUrls,
  extensionShim,
  extensionUrls,
  startEngine,
  WASM_HANDOFF_URL,
  workerShim,
} from '../../src/viewer/data/engine/start.js';
import type { ScriptLoader } from '../../src/viewer/data/script-loader.js';

const fake = vi.hoisted(() => ({
  instantiated: [] as string[],
  opened: [] as unknown[],
  events: [] as string[],
  failInstantiate: false,
  failOpen: false,
  failConnect: false,
  failConnectionClose: false,
  failLoad: '' as string,
  statements: [] as string[],
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
    async connect(): Promise<{ close(): Promise<void>; query(sql: string): Promise<void> }> {
      if (fake.failConnect) throw new Error('connect failed');
      return {
        query: async (sql: string) => {
          fake.statements.push(sql);
          fake.events.push(`query:${sql}`);
          if (fake.failLoad !== '' && sql.includes(fake.failLoad)) throw new Error('null function');
        },
        close: async () => {
          if (fake.failConnectionClose) throw new Error('close failed');
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
  fake.failConnectionClose = false;
  fake.instantiated.length = 0;
  fake.opened.length = 0;
  fake.events.length = 0;
  fake.statements.length = 0;
  fake.failLoad = '';
  posted.length = 0;
});

const localEngine = { version: '1.32.0', format: 'local', assetsBase: 'assets/' } as const;
const siteEngine = { version: '1.32.0', format: 'site', assetsBase: 'assets/' } as const;

const EXT_PAYLOADS = {
  [engineExtensionKey('parquet')]: toBase64(gzipSync(Buffer.from('PQ'))),
  [engineExtensionKey('json')]: toBase64(gzipSync(Buffer.from('JS'))),
};

function scriptedLoader(payloads: Record<string, string>): ScriptLoader {
  return { load: async (_path, key) => payloads[key] };
}

const EMBEDDED = 'https://oh-engine.invalid/';
type Posted = [{ __oh: { wasm: ArrayBuffer } }, Transferable[]];
const posted: Posted[] = [];

function fakeWorker(): Worker {
  return {
    postMessage: (message: Posted[0], transfer: Transferable[]) => {
      posted.push([message, transfer]);
    },
  } as unknown as Worker;
}

const SITE_FILES: Record<string, string> = {
  'duckdb.1.32.0.wasm': 'WASM',
  'duckdb.1.32.0.worker.js': 'self.x=1',
  'parquet.1.32.0.duckdb_extension.wasm': 'PQ',
  'json.1.32.0.duckdb_extension.wasm': 'JS',
};

/** A fake `fetch` over SITE_FILES (by last path segment); records every requested URL. */
function fakeFetch(requested: string[] = [], status: Record<string, number> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const name = url.slice(url.lastIndexOf('/') + 1);
    const code = status[name] ?? 200;
    return new Response(code === 200 ? SITE_FILES[name] : 'nope', { status: code });
  }) as typeof fetch;
}

function deps(loader: ScriptLoader, created: string[] = [], revoked: string[] = []): EngineDeps {
  return {
    loader,
    baseUrl: 'file:///r/index.html',
    fetch: fakeFetch(),
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

test('local: the wasm is posted to the worker as a transferred buffer and instantiated through the hand-off URL', async () => {
  const created: string[] = [];
  const revoked: string[] = [];
  const engine = await startEngine(localEngine, deps(localLoader(), created, revoked));
  expect(fake.instantiated).toEqual([WASM_HANDOFF_URL]);
  expect(WASM_HANDOFF_URL).toBe(`${EMBEDDED}duckdb.wasm`);
  expect(posted).toHaveLength(1);
  const [message, transfer] = posted[0] as Posted;
  expect(Object.keys(message)).toEqual(['__oh']);
  expect(new TextDecoder().decode(new Uint8Array(message.__oh.wasm))).toBe('WASM');
  expect(transfer).toEqual([message.__oh.wasm]);
  expect(created[0]).toMatch(/^blob:/);
  expect(revoked).toEqual(['blob:fake-1']);
  expect(engine.format).toBe('local');
});

test('local: the four wrappers load concurrently', async () => {
  const requested: string[] = [];
  let release: () => void = () => undefined;
  const all = new Promise<void>((r) => {
    release = r;
  });
  const payloads = {
    [ENGINE_WASM_KEY]: toBase64(gzipSync(Buffer.from('WASM'))),
    [ENGINE_WORKER_KEY]: toBase64(Buffer.from('self.x=1')),
    ...EXT_PAYLOADS,
  };
  const loader: ScriptLoader = {
    load: async (_p, key) => {
      requested.push(key);
      if (requested.length === 4) release();
      await all;
      return payloads[key as keyof typeof payloads];
    },
  };
  await startEngine(localEngine, deps(loader));
  expect(requested).toHaveLength(4);
});

test('site: the worker script, the wasm and both extensions are fetched concurrently and the worker is a blob', async () => {
  const fetched: string[] = [];
  let release: () => void = () => undefined;
  const all = new Promise<void>((r) => {
    release = r;
  });
  const inner = fakeFetch(fetched);
  const d = deps({ load: vi.fn() });
  d.fetch = (async (input: string) => {
    const r = inner(input);
    if (fetched.length === 4) release();
    await all;
    return r;
  }) as typeof fetch;
  const created: string[] = [];
  d.createWorker = (u) => {
    created.push(u);
    return fakeWorker();
  };
  const urls = engineUrls(siteEngine, d.baseUrl);
  const ext = extensionUrls(siteEngine, d.baseUrl);
  const engine = await startEngine(siteEngine, d);
  expect(fetched).toHaveLength(4);
  expect(fetched).toEqual(expect.arrayContaining([urls.worker, urls.wasm, ext.parquet, ext.json]));
  expect(created).toEqual(['blob:fake-1']);
  expect(fake.instantiated).toEqual([WASM_HANDOFF_URL]);
  expect(new TextDecoder().decode(new Uint8Array((posted[0] as Posted)[0].__oh.wasm))).toBe('WASM');
  expect(fake.opened).toEqual([{ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true } }]);
  expect(engine.format).toBe('site');
});

test('site: a prefetched promise is used instead of a fetch; a rejected one falls back to one fetch', async () => {
  const fetched: string[] = [];
  const d = deps({ load: vi.fn() });
  d.fetch = fakeFetch(fetched);
  const asked: string[] = [];
  d.prefetched = (href) => {
    asked.push(href);
    if (href === 'assets/duckdb.1.32.0.wasm') return Promise.resolve(new TextEncoder().encode('PRE').buffer);
    if (href === 'assets/duckdb.1.32.0.worker.js') return Promise.reject(new Error('early fetch failed'));
    return undefined;
  };
  await startEngine(siteEngine, d);
  expect(asked.sort()).toEqual([
    'assets/duckdb.1.32.0.wasm',
    'assets/duckdb.1.32.0.worker.js',
    'assets/json.1.32.0.duckdb_extension.wasm',
    'assets/parquet.1.32.0.duckdb_extension.wasm',
  ]);
  expect(fetched).not.toContain('file:///r/assets/duckdb.1.32.0.wasm');
  expect(fetched.filter((u) => u.endsWith('worker.js'))).toEqual([
    'file:///r/assets/duckdb.1.32.0.worker.js',
  ]);
  expect(fetched).toHaveLength(3);
  expect(new TextDecoder().decode(new Uint8Array((posted[0] as Posted)[0].__oh.wasm))).toBe('PRE');
});

test('site: a 404 on an engine file is the D13 error naming it', async () => {
  const d = deps({ load: vi.fn() });
  d.fetch = fakeFetch([], { 'json.1.32.0.duckdb_extension.wasm': 404 });
  const err = await startEngine(siteEngine, d).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(OtelHtmlError);
  expect(err).toMatchObject({
    code: 'invalid-report',
    path: 'file:///r/assets/json.1.32.0.duckdb_extension.wasm',
  });
  expect((err as Error).message).toContain('json.1.32.0.duckdb_extension.wasm');
});

test('both formats LOAD the extensions through the shim and point the repositories at the embedded host', async () => {
  for (const [spec, d] of [
    [localEngine, deps(localLoader())],
    [siteEngine, deps({ load: vi.fn() })],
  ] as const) {
    fake.statements.length = 0;
    await startEngine(spec, d);
    expect(fake.statements).toEqual(
      expect.arrayContaining([
        `LOAD '${EMBEDDED}parquet.duckdb_extension.wasm'`,
        `LOAD '${EMBEDDED}json.duckdb_extension.wasm'`,
        `SET custom_extension_repository = '${EMBEDDED}no-extensions'`,
        `SET autoinstall_extension_repository = '${EMBEDDED}no-extensions'`,
      ]),
    );
  }
});

test('workerShim serves the posted buffer to a fetch of the hand-off URL and passes other fetches through', async () => {
  const listeners: [string, (e: unknown) => void, unknown][] = [];
  const passed: unknown[] = [];
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void, c: unknown) => listeners.push([t, fn, c]),
    fetch: async (input: unknown) => {
      passed.push(input);
      return 'passed';
    },
  };
  new Function('self', 'XMLHttpRequest', workerShim({}))(self, class {});
  expect(listeners).toHaveLength(1);
  const [type, fn, capture] = listeners[0] as (typeof listeners)[number];
  expect([type, capture]).toEqual(['message', true]);
  let stopped = 0;
  const buffer = new TextEncoder().encode('WASM').buffer;
  fn({ data: { __oh: { wasm: buffer } }, stopImmediatePropagation: () => stopped++ });
  expect(stopped).toBe(1);
  // another message is left alone
  fn({ data: { type: 'x' }, stopImmediatePropagation: () => stopped++ });
  expect(stopped).toBe(1);
  const viaRequest = (await self.fetch({ url: WASM_HANDOFF_URL })) as unknown as Response;
  expect(viaRequest.headers.get('content-type')).toBe('application/wasm');
  expect(new TextDecoder().decode(await viaRequest.arrayBuffer())).toBe('WASM');
  const viaString = (await self.fetch(WASM_HANDOFF_URL)) as unknown as Response;
  expect(viaString.headers.get('content-type')).toBe('application/wasm');
  expect(await self.fetch('https://example.test/a')).toBe('passed');
  expect(await self.fetch({ url: 'https://example.test/b' })).toBe('passed');
  expect(passed).toHaveLength(2);
});

test('registerText and close reach the database and connection', async () => {
  const engine = await startEngine(siteEngine, deps({ load: vi.fn() }));
  await engine.registerText('ids.csv', 'a,b');
  await engine.close();
  expect(fake.events).toContain('register:ids.csv:a,b');
  expect(fake.events.slice(-2)).toEqual(['connection.close', 'db.terminate']);
});

test('close still terminates the database when the connection will not close, and the error surfaces', async () => {
  const engine = await startEngine(siteEngine, deps({ load: vi.fn() }));
  fake.failConnectionClose = true;
  await expect(engine.close()).rejects.toThrow('close failed');
  expect(fake.events).toContain('db.terminate');
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
      if (key === ENGINE_WASM_KEY) return toBase64(gzipSync(Buffer.from('WASM')));
      return EXT_PAYLOADS[key as keyof typeof EXT_PAYLOADS] ?? toBase64(Buffer.from('x'));
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
    ...EXT_PAYLOADS,
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
    path: expect.stringMatching(/^file:\/\/\/r\/assets\/duckdb\.1\.32\.0\..*\.b64\.js$/),
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

test('extensionUrls resolves the two extension files for each format', () => {
  expect(extensionUrls(localEngine, 'file:///r/index.html')).toEqual({
    parquet: 'file:///r/assets/duckdb.1.32.0.parquet.ext.gz.b64.js',
    json: 'file:///r/assets/duckdb.1.32.0.json.ext.gz.b64.js',
  });
  expect(extensionUrls(siteEngine, 'https://x.test/s/index.html')).toEqual({
    parquet: 'https://x.test/s/assets/parquet.1.32.0.duckdb_extension.wasm',
    json: 'https://x.test/s/assets/json.1.32.0.duckdb_extension.wasm',
  });
});

test('local start loads both extensions through the embedded address, after the autoload settings', async () => {
  await startEngine(localEngine, deps(localLoader()));
  expect(fake.statements).toEqual([
    'SET autoinstall_known_extensions = false',
    'SET autoload_known_extensions = false',
    "LOAD 'https://oh-engine.invalid/parquet.duckdb_extension.wasm'",
    "LOAD 'https://oh-engine.invalid/json.duckdb_extension.wasm'",
    "SET autoinstall_extension_repository = 'https://oh-engine.invalid/no-extensions'",
    "SET custom_extension_repository = 'https://oh-engine.invalid/no-extensions'",
  ]);
});

test.each([
  ['local', localEngine, 'file:///r/assets/duckdb.1.32.0.json.ext.gz.b64.js'],
  ['site', siteEngine, 'file:///r/assets/json.1.32.0.duckdb_extension.wasm'],
] as const)(
  '%s: a failed extension load is an invalid-report naming the file, and ends the engine',
  async (_f, spec, url) => {
    fake.failLoad = 'json.';
    const err = await startEngine(spec, deps(localLoader())).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid-report', path: url });
    expect((err as Error).message).toContain('DuckDB json extension');
    expect((err as Error).message).toContain('null function');
    expect(fake.events).toContain('db.terminate');
  },
);

test('the worker shim answers the embedded address from the data URL and leaves every other request alone', () => {
  const opened: unknown[][] = [];
  class FakeXhr {
    open(...args: unknown[]): void {
      opened.push(args);
    }
  }
  const scope = { XMLHttpRequest: FakeXhr };
  new Function('XMLHttpRequest', extensionShim({ 'parquet.duckdb_extension.wasm': 'data:x;base64,UFE=' }))(
    scope.XMLHttpRequest,
  );
  const x = new FakeXhr();
  x.open('GET', 'https://oh-engine.invalid/parquet.duckdb_extension.wasm', false);
  x.open('GET', 'https://oh-engine.invalid/icu.duckdb_extension.wasm', false);
  x.open('GET', 'https://example.test/parquet.duckdb_extension.wasm', false);
  expect(opened).toEqual([
    ['GET', 'data:x;base64,UFE=', false],
    ['GET', 'data:,', false],
    ['GET', 'https://example.test/parquet.duckdb_extension.wasm', false],
  ]);
});

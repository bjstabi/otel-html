import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineAssetNames, engineExtensionName, engineNodeAssetNames } from '../format/engine.js';
import { OtelHtmlError } from '../model/errors.js';
import { type BunLike, hasBunEmbeddedFiles } from '../writer/viewer-assets.js';

/** The files the Node engine runs from: real paths on disk, because `worker_threads` and the Emscripten glue need them. */
export interface HostEngineFiles {
  readonly bindings: string;
  readonly worker: string;
  readonly wasm: string;
  /** The signed `parquet` and `json` extensions: this build carries neither, and the viewer's SQL needs both. */
  readonly extensions: { readonly parquet: string; readonly json: string };
  close(): Promise<void>;
}

const NOOP = async (): Promise<void> => {};

const DEFAULT_DIRS: readonly URL[] = [
  // Published, by where the bundler puts this code: a shared chunk directly in dist/ (as dist/index.js is) finds
  // dist/viewer/assets/ at `./viewer/assets/`; code bundled into dist/cli/main.js finds it at `../viewer/assets/`.
  new URL('./viewer/assets/', import.meta.url),
  new URL('../viewer/assets/', import.meta.url),
  new URL('../../dist/viewer/assets/', import.meta.url), // development: src/host/engine-files.ts
];

function names(): { bindings: string; worker: string; wasm: string; parquet: string; json: string } {
  const [wasm] = engineAssetNames('site');
  if (wasm === undefined) throw new Error('no site wasm name');
  return {
    ...engineNodeAssetNames(),
    wasm,
    parquet: engineExtensionName('site', 'parquet'),
    json: engineExtensionName('site', 'json'),
  };
}

function notFound(bindings: string): OtelHtmlError {
  return new OtelHtmlError('usage', {
    message: `the DuckDB engine files for \`host\` were not found (${bindings})`,
    hint: 'run the viewer build',
  });
}

function fromDirs(dirs: readonly URL[]): HostEngineFiles | undefined {
  const n = names();
  for (const dir of dirs) {
    const base = fileURLToPath(dir);
    const files = {
      bindings: join(base, n.bindings),
      worker: join(base, n.worker),
      wasm: join(base, n.wasm),
    };
    const extensions = { parquet: join(base, n.parquet), json: join(base, n.json) };
    if (
      [files.bindings, files.worker, files.wasm, ...Object.values(extensions)].every((f) => existsSync(f))
    ) {
      return { ...files, extensions, close: NOOP };
    }
  }
  return undefined;
}

/** The installed package's own copies (development without a build); undefined when it is not installed. */
function fromPackage(): HostEngineFiles | undefined {
  try {
    const require = createRequire(import.meta.url);
    const bindings = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node.cjs');
    const dist = dirname(bindings);
    // The extension is not in the package: the build's own cache (scripts/engine-assets.ts) has it.
    const cached = (e: string): string =>
      fileURLToPath(new URL(`../../.cache/duckdb-extensions/${e}.duckdb_extension.wasm`, import.meta.url));
    const extensions = { parquet: cached('parquet'), json: cached('json') };
    if (!Object.values(extensions).every((f) => existsSync(f))) return undefined;
    return {
      bindings,
      worker: join(dist, 'duckdb-node-eh.worker.cjs'),
      wasm: join(dist, 'duckdb-eh.wasm'),
      extensions,
      close: NOOP,
    };
  } catch {
    return undefined;
  }
}

async function fromBun(bun: BunLike): Promise<HostEngineFiles> {
  const n = names();
  const wanted = [n.bindings, n.worker, n.wasm, n.parquet, n.json];
  const dir = await mkdtemp(join(tmpdir(), 'otel-html-host-'));
  try {
    for (const name of wanted) {
      const blob = (bun.embeddedFiles ?? []).find((f) => f.name === name);
      if (blob === undefined) throw notFound(n.bindings);
      await writeFile(join(dir, name), new Uint8Array(await blob.arrayBuffer()));
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    bindings: join(dir, n.bindings),
    worker: join(dir, n.worker),
    wasm: join(dir, n.wasm),
    extensions: { parquet: join(dir, n.parquet), json: join(dir, n.json) },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Node: the first of `dirs` (default: `dist/viewer/assets/` beside the published entry, then in a development checkout)
 * holding the five files; with no `dirs` and none found, the installed package's own copies (a checkout without a build;
 * located by path, not imported). Bun binary: the embedded files written into a temp folder that `close()` removes.
 * Nothing found is `usage` naming the bindings file, with the hint "run the viewer build".
 */
export async function hostEngineFiles(
  opts: { dirs?: readonly URL[]; bun?: BunLike } = {},
): Promise<HostEngineFiles> {
  const bunGlobal = (globalThis as { Bun?: BunLike }).Bun;
  const bun = opts.bun ?? bunGlobal;
  if (hasBunEmbeddedFiles(bun) && bun !== undefined) return fromBun(bun);
  const found = fromDirs(opts.dirs ?? DEFAULT_DIRS) ?? (opts.dirs === undefined ? fromPackage() : undefined);
  if (found === undefined) throw notFound(names().bindings);
  return found;
}

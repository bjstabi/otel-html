// Compiles the CLI into standalone binaries with `bun build --compile` and writes dist/bin/SHA256SUMS.
//   bun scripts/build-binaries.ts [--target <t>]
// Bun treats `.js` arguments as entry points to bundle, and renames `import … with { type: 'file' }` assets
// with a content hash unless `--asset-naming '[name].[ext]'` is given. So a throwaway entry file (under
// dist/, never committed) imports each viewer asset as a file, which embeds it under its original name
// (`Bun.embeddedFiles`), then loads the real CLI entry.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const;
type Target = (typeof TARGETS)[number];

const root = resolve(import.meta.dirname, '..');
const viewerAssets = join(root, 'dist', 'viewer', 'assets');
const binDir = join(root, 'dist', 'bin');
const entryDir = join(binDir, '.entry');

function fail(message: string): never {
  process.stderr.write(`build-binaries: ${message}\n`);
  process.exit(1);
}

function parseTargets(argv: readonly string[]): readonly Target[] {
  const i = argv.indexOf('--target');
  if (i === -1) return TARGETS;
  const value = argv[i + 1];
  const target = TARGETS.find((t) => t === value);
  if (target === undefined)
    fail(`unknown --target ${JSON.stringify(value)}; expected one of ${TARGETS.join(', ')}`);
  return [target];
}

function posix(p: string): string {
  return p.split('\\').join('/');
}

function writeEntry(): string {
  const assets = readdirSync(viewerAssets).sort();
  const imports = assets.map(
    (n) =>
      `import ${JSON.stringify(posix(relative(entryDir, join(viewerAssets, n))))} with { type: 'file' };`,
  );
  const main = posix(relative(entryDir, join(root, 'src', 'cli', 'main.ts')));
  const file = join(entryDir, 'entry.ts');
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(file, `${imports.join('\n')}\nimport ${JSON.stringify(main)};\n`);
  return file;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Merges by filename so a single-target run keeps the other targets' lines. */
function writeSums(built: readonly string[]): void {
  const sums = join(binDir, 'SHA256SUMS');
  const lines = new Map<string, string>();
  if (existsSync(sums)) {
    for (const line of readFileSync(sums, 'utf8').split('\n')) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined && existsSync(join(binDir, m[2]))) lines.set(m[2], m[1]);
    }
  }
  for (const name of built) lines.set(name, sha256(join(binDir, name)));
  const body = [...lines.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, hex]) => `${hex}  ${name}\n`)
    .join('');
  writeFileSync(sums, body);
}

function main(): void {
  const targets = parseTargets(process.argv.slice(2));
  if (!existsSync(viewerAssets)) fail('dist/viewer is missing; run `mise run build` first');
  mkdirSync(binDir, { recursive: true });
  const entry = writeEntry();
  const built: string[] = [];
  try {
    for (const target of targets) {
      const name = `otel-html-${target}${target.startsWith('windows') ? '.exe' : ''}`;
      process.stdout.write(`building ${name}\n`);
      const r = spawnSync(
        process.execPath,
        [
          'build',
          '--compile',
          `--target=bun-${target}`,
          '--asset-naming',
          '[name].[ext]',
          entry,
          '--outfile',
          join(binDir, name),
        ],
        { stdio: 'inherit', cwd: root },
      );
      if (r.status !== 0) fail(`bun build failed for ${target}`);
      built.push(name);
    }
  } finally {
    rmSync(entryDir, { recursive: true, force: true });
  }
  writeSums(built);
}

main();

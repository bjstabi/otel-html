import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readZip } from '../../../src/cli/ci/zip.js';
import { buildZip } from '../../../test-support/zip.js';

const dec = new TextDecoder();
const text = (m: Map<string, Uint8Array>, k: string): string => dec.decode(m.get(k));
const has = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const HAS_ZIP = has('zip', ['-v']);
const HAS_PY = has('python3', ['-c', 'import zipfile']);
const big = 'otel-html '.repeat(500);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readZip', () => {
  test('reads stored and deflated entries from a hand-built zip', () => {
    const m = readZip(
      buildZip([
        { name: 'update.json', data: '{"a":1}' },
        { name: 'partitions/0/spans.parquet', data: big, method: 'deflate' },
        { name: 'partitions/', data: '' },
      ]),
      1 << 20,
    );
    expect([...m.keys()]).toEqual(['update.json', 'partitions/0/spans.parquet']);
    expect(text(m, 'update.json')).toBe('{"a":1}');
    expect(text(m, 'partitions/0/spans.parquet')).toBe(big);
  });

  test.skipIf(!HAS_ZIP)('reads a zip made by the system zip', () => {
    const src = join(dir, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'a.txt'), big);
    writeFileSync(join(src, 'sub', 'b.txt'), 'b');
    const out = join(dir, 'out.zip');
    expect(spawnSync('zip', ['-qr', out, '.'], { cwd: src }).status).toBe(0);
    const m = readZip(readFileSync(out), 1 << 20);
    expect(text(m, 'a.txt')).toBe(big);
    expect(text(m, 'sub/b.txt')).toBe('b');
  });

  test.skipIf(!HAS_ZIP)('reads a zip64 end record made by zip -fz', () => {
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'a.txt'), big);
    const out = join(dir, 'z64.zip');
    expect(spawnSync('zip', ['-qr', '-fz', out, '.'], { cwd: src }).status).toBe(0);
    expect(text(readZip(readFileSync(out), 1 << 20), 'a.txt')).toBe(big);
  });

  test.skipIf(!HAS_PY)("reads a zip made by Python's zipfile with ZIP_DEFLATED", () => {
    const out = join(dir, 'py.zip');
    const script = [
      'import sys, zipfile',
      "z = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED)",
      "z.writestr('x/y.txt', 'otel-html ' * 500)",
      "z.writestr('z.bin', bytes(range(256)))",
      'z.close()',
    ].join('\n');
    expect(spawnSync('python3', ['-I', '-c', script, out]).status).toBe(0);
    const m = readZip(readFileSync(out), 1 << 20);
    expect(text(m, 'x/y.txt')).toBe(big);
    expect([...(m.get('z.bin') ?? [])]).toEqual([...Array(256).keys()]);
  });

  test('reads a hand-built zip64 end record', () => {
    const m = readZip(
      buildZip(
        [
          { name: 'a.txt', data: 'one', method: 'stored' },
          { name: 'b.txt', data: big, method: 'deflate' },
        ],
        { zip64: true },
      ),
      1 << 20,
    );
    expect(text(m, 'a.txt')).toBe('one');
    expect(text(m, 'b.txt')).toBe(big);
  });

  test.each(['../x', 'a/../../x', '/abs', 'C:/x', 'a\\..\\x'])('rejects the name %s, naming it', (name) => {
    expect(() => readZip(buildZip([{ name, data: 'x' }]), 1000)).toThrow(name);
  });

  test('rejects a symlink entry, naming it', () => {
    const zip = buildZip([{ name: 'link', data: '/etc/passwd', attrs: 0xa1ff0000 }]);
    expect(() => readZip(zip, 1000)).toThrow(/link.*symbolic link/s);
  });

  test.each(['stored', 'deflate'] as const)(
    'rejects a %s size that disagrees with the directory',
    (method) => {
      const zip = buildZip([{ name: 'bad.txt', data: 'hello world', method, declaredSize: 5 }]);
      expect(() => readZip(zip, 1000)).toThrow(/bad\.txt/);
      const longer = buildZip([{ name: 'bad.txt', data: 'hello world', method, declaredSize: 50 }]);
      expect(() => readZip(longer, 1000)).toThrow(/bad\.txt/);
    },
  );

  test('rejects a total over maxBytes, naming the entry that crosses it', () => {
    const zip = buildZip([
      { name: 'a', data: 'x'.repeat(60) },
      { name: 'b', data: 'y'.repeat(60) },
    ]);
    expect(readZip(zip, 120).size).toBe(2);
    expect(() => readZip(zip, 119)).toThrow(/b/);
  });

  test('rejects a deflate bomb by its declared size before inflating', () => {
    const zip = buildZip([{ name: 'bomb', data: 'a'.repeat(100_000), method: 'deflate' }]);
    expect(() => readZip(zip, 1000)).toThrow(/bomb/);
  });

  test('rejects a duplicate name and bytes that are not a zip', () => {
    const dup = buildZip([
      { name: 'a', data: '1' },
      { name: 'a', data: '2' },
    ]);
    expect(() => readZip(dup, 1000)).toThrow(/a/);
    expect(() => readZip(new Uint8Array(10), 1000)).toThrow(/zip/);
  });
});

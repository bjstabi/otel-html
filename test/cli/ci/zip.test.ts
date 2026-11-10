import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readZip, storedZip } from '../../../src/cli/ci/zip.js';
import { OtelHtmlError } from '../../../src/model/errors.js';
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
    expect(() => readZip(zip, 119)).toThrow(/^b: /);
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
    expect(() => readZip(dup, 1000)).toThrow(/^a: a duplicate entry/);
    expect(() => readZip(new Uint8Array(10), 1000)).toThrow(/^zip: no end of central directory/);
  });

  test('rejects a file that is also a parent folder of another entry, in either order', () => {
    for (const names of [
      ['a', 'a/b'],
      ['a/b', 'a'],
    ]) {
      const z = buildZip(names.map((name) => ({ name, data: 'x' })));
      expect(() => readZip(z, 1000)).toThrow(/^a: a file and a folder of the same name/);
    }
  });

  describe('malformed input is a typed rejection', () => {
    const good = (): Uint8Array =>
      buildZip([
        { name: 'a.txt', data: 'hello' },
        { name: 'b.txt', data: big, method: 'deflate' },
      ]);
    const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const eocd = (b: Uint8Array): number => b.length - 22;
    const rejects = (b: Uint8Array, re: RegExp): void => {
      let err: unknown;
      try {
        readZip(b, 1 << 20);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OtelHtmlError);
      expect((err as OtelHtmlError).message).toMatch(re);
    };

    test('a truncated central directory', () => {
      const b = good();
      view(b).setUint32(eocd(b) + 16, b.length - 30, true); // the directory starts too near the end
      rejects(b, /^zip: /);
    });

    test('a central directory record whose name runs past the end', () => {
      const b = good();
      const cd = view(b).getUint32(eocd(b) + 16, true);
      view(b).setUint16(cd + 28, 60000, true);
      rejects(b, /^zip: /);
    });

    test('a zip64 locator pointing past the end', () => {
      const b = buildZip([{ name: 'a.txt', data: 'x' }], { zip64: true });
      view(b).setBigUint64(b.length - 22 - 20 + 8, 0xffffffffffffn, true);
      rejects(b, /^zip: /);
      view(b).setBigUint64(b.length - 22 - 20 + 8, 2n ** 63n, true);
      rejects(b, /^zip: /);
    });

    test('a local-header offset past the end', () => {
      const b = good();
      const cd = view(b).getUint32(eocd(b) + 16, true);
      view(b).setUint32(cd + 42, b.length - 5, true);
      rejects(b, /^a\.txt: /);
    });

    test('an extra field running past its record', () => {
      const b = buildZip([{ name: 'a.txt', data: 'x' }], { zip64: true });
      const cd =
        view(b).getUint32(eocd(b) + 16, true) || view(b).getUint32(b.length - 22 - 20 - 56 + 48, true);
      // find the record through the zip64 end record instead
      const z = Number(view(b).getBigUint64(b.length - 22 - 20 + 8, true));
      const rec = Number(view(b).getBigUint64(z + 48, true));
      expect(cd).toBeGreaterThan(0);
      view(b).setUint16(rec + 46 + 5 + 2, 60000, true); // the zip64 extra's size field
      rejects(b, /^a\.txt: /);
    });
  });
});

describe('storedZip', () => {
  const mtime = new Date(Date.UTC(2026, 10, 10, 12, 30, 40));
  const files = [
    { name: 'a.txt', bytes: new TextEncoder().encode('hello'), mtime },
    { name: 'dir/ü.bin', bytes: new Uint8Array([1, 2, 3, 255]), mtime },
  ];

  test('reads back with readZip', () => {
    const m = readZip(storedZip(files), 1 << 20);
    expect([...m.keys()]).toEqual(['a.txt', 'dir/ü.bin']);
    expect(text(m, 'a.txt')).toBe('hello');
    expect([...(m.get('dir/ü.bin') ?? [])]).toEqual([1, 2, 3, 255]);
  });

  test('crc32 of hello is the standard value', () => {
    expect(crc32('hello')).toBe(0x3610a686);
    const z = storedZip([files[0] as (typeof files)[number]]);
    expect(new DataView(z.buffer, z.byteOffset).getUint32(14, true)).toBe(0x3610a686);
  });

  test('an empty list is a valid zip', () => {
    expect(readZip(storedZip([]), 10).size).toBe(0);
  });

  test.skipIf(!HAS_PY)('python zipfile accepts it and tests clean', () => {
    const f = join(dir, 'x.zip');
    writeFileSync(f, storedZip(files));
    const r = spawnSync(
      'python3',
      [
        '-I',
        '-c',
        'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(",".join(z.namelist()))',
        f,
      ],
      { encoding: 'utf8' },
    );
    expect(r.stdout.trim()).toBe('a.txt,dir/ü.bin');
  });

  test('DOS time and date words and the UTF-8 flag are set in both headers', () => {
    const z = storedZip([files[0] as (typeof files)[number]]);
    const v = new DataView(z.buffer, z.byteOffset);
    const time = (12 << 11) | (30 << 5) | (40 >> 1);
    const date = ((2026 - 1980) << 9) | (11 << 5) | 10;
    expect([v.getUint16(10, true), v.getUint16(12, true)]).toEqual([time, date]);
    expect(v.getUint16(6, true) & 0x0800).toBe(0x0800);
    const cd = 30 + 5 + 5;
    expect(v.getUint32(cd, true)).toBe(0x02014b50);
    expect(v.getUint16(cd + 8, true) & 0x0800).toBe(0x0800);
    expect([v.getUint16(cd + 12, true), v.getUint16(cd + 14, true)]).toEqual([time, date]);
  });

  test('refuses more than 65535 files with usage', () => {
    const many = Array.from({ length: 0x10000 }, () => ({ name: 'f', bytes: new Uint8Array(0), mtime }));
    expect(() => storedZip(many)).toThrow(expect.objectContaining({ code: 'usage' }));
  });

  test('refuses a total above 4 GiB with usage', () => {
    const fake = { length: 0x80000000 } as unknown as Uint8Array;
    const e = (() => {
      try {
        storedZip([
          { name: 'a', bytes: fake, mtime },
          { name: 'b', bytes: fake, mtime },
        ]);
        return undefined;
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(OtelHtmlError);
    expect((e as OtelHtmlError).code).toBe('usage');
  });
});

import { describe, expect, test } from 'vitest';
import {
  reviveDataJson,
  unwrapDataFile,
  wrapDataFile,
  wrapDataFilePieces,
} from '../../src/format/data-file.js';
import { REGISTRATION_GLOBAL } from '../../src/format/version.js';
import { OtelHtmlError } from '../../src/model/errors.js';

const HOSTILE = '</script><img src=x onerror=alert(1)> \u2028\u2029';

describe('data files', () => {
  test('data files are inert against hostile strings', () => {
    const s = wrapDataFile('chunks/spans/000001', { name: HOSTILE });
    expect(s.startsWith('__OH__.push("chunks/spans/000001",')).toBe(true);
    expect(s.endsWith(');\n')).toBe(true);
    expect(s).not.toMatch(/<\/script|<img|\u2028|\u2029/);
    expect(s).not.toContain('<');
    expect(unwrapDataFile(s, 'chunks/spans/000001')).toEqual({ name: HOSTILE });
  });

  test('hostile keys are escaped too', () => {
    const key = '</script>k';
    const s = wrapDataFile(key, 1);
    expect(s).not.toContain('<');
    expect(unwrapDataFile(s, key)).toBe(1);
  });

  test('the file is a single classic-script statement that executes to the same payload', () => {
    const payload = { name: HOSTILE, nested: [1, 'two', null, true] };
    const seen: [string, unknown][] = [];
    new Function('__OH__', wrapDataFile('k', payload))({
      push: (k: string, v: unknown) => seen.push([k, v]),
    });
    expect(seen).toEqual([['k', payload]]);
  });

  test('bigint and Uint8Array use $i / $b tags and revive exactly', () => {
    const big = 2n ** 63n - 1n;
    const s = wrapDataFile('k', { big, neg: -(2n ** 60n), bytes: new Uint8Array([0, 255, 7]) });
    expect(s).toContain(`{"$i":"${big}"}`);
    expect(s).toContain('"$b":"AP8H"');
    const raw = unwrapDataFile(s, 'k');
    expect(raw).toEqual({
      big: { $i: big.toString() },
      neg: { $i: (-(2n ** 60n)).toString() },
      bytes: { $b: 'AP8H' },
    });
    expect(reviveDataJson(raw)).toEqual({ big, neg: -(2n ** 60n), bytes: new Uint8Array([0, 255, 7]) });
  });

  test('unwrap rejects wrong key, bad prefix, bad suffix and bad JSON with invalid-report', () => {
    const ok = wrapDataFile('a', { x: 1 });
    const bad = (text: string, path: string): void => {
      try {
        unwrapDataFile(text, 'a');
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OtelHtmlError);
        expect((e as OtelHtmlError).code).toBe('invalid-report');
        expect((e as OtelHtmlError).path).toBe(path);
      }
    };
    expect(() => unwrapDataFile(ok, 'b')).toThrowError(/expected .*"b"/);
    bad(ok.replace('__OH__', 'window'), 'prefix');
    bad(ok.replace('"a"', '"b"'), 'prefix');
    bad(ok.slice(0, -3), 'suffix');
    bad(`__OH__.push("a",{);\n`, 'payload');
  });

  test('revive rejects malformed tags', () => {
    expect(() => reviveDataJson({ $i: 'abc' })).toThrowError(OtelHtmlError);
    expect(() => reviveDataJson({ $b: 5 })).toThrowError(OtelHtmlError);
    expect(reviveDataJson([{ $i: '5' }, 'x'])).toEqual([5n, 'x']);
    const at = (v: unknown): unknown => {
      try {
        reviveDataJson(v);
      } catch (e) {
        return e instanceof OtelHtmlError ? e.path : e;
      }
      return 'revived';
    };
    expect(at({ cols: { start: [1, 2, { $i: 'x' }] } })).toBe('cols.start[2]');
    expect(at([0, [{ ok: { $b: 5 } }]])).toBe('(root)[1][0].ok');
    expect(at({ $i: 'abc' })).toBe('(root)');
  });

  test('wrapDataFile rejects values JSON cannot carry', () => {
    expect(() => wrapDataFile('k', { x: Number.NaN })).toThrowError(/finite/);
    expect(() => wrapDataFile('k', { x: () => 1 })).toThrowError(OtelHtmlError);
  });

  test('plain payloads skip the replacer but write exactly what the tagging replacer would', () => {
    // The replacer wrapDataFile applied to every payload before plain JSON took a fast path.
    const tagging = (_k: string, v: unknown): unknown =>
      typeof v === 'bigint'
        ? { $i: v.toString() }
        : v instanceof Uint8Array
          ? { $b: Buffer.from(v).toString('base64') }
          : v;
    const payloads: unknown[] = [
      { a: [1, -0, 'x', null, true, { b: undefined }, undefined], c: undefined, d: HOSTILE },
      [{ k: 'number', count: 1, sum: 1.5e300, min: -5e-324, max: 0, last: 2, lastTime: 3 }],
      { when: new Date(0), map: new Map([['k', 1]]), nested: { deep: [[[{}]]] } },
      { plain: [1, 2, 3], late: { big: 2n ** 70n } },
      [new Uint8Array([0, 255]), 'x'],
      7,
      'text',
      null,
    ];
    for (const p of payloads) {
      const json = JSON.stringify(p, tagging).replace(
        /[<\u2028\u2029]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      expect(wrapDataFile('k', p)).toBe(`${REGISTRATION_GLOBAL}.push("k",${json});\n`);
      expect([...wrapDataFilePieces('k', { h: 1 }, 'items', [p])].join('')).toBe(
        wrapDataFile('k', { h: 1, items: [p] }),
      );
    }
    // A value JSON cannot carry fails the same way wherever it hides, naming its key.
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -Number.MAX_VALUE * 2]) {
      expect(() => wrapDataFile('k', { ok: [1, 2], deep: [{ x: bad }] })).toThrowError(
        expect.objectContaining({ code: 'invalid-report', path: 'x', expected: 'a finite number' }),
      );
    }
    expect(() => wrapDataFile('k', [{ f: Symbol('s') }])).toThrowError(
      expect.objectContaining({ path: 'f', expected: 'a JSON-serializable value' }),
    );
  });

  test('wrapDataFilePieces joins to exactly wrapDataFile of the whole payload', () => {
    const items = [{ id: 0, s: HOSTILE }, { id: 1, n: 2n ** 70n, b: new Uint8Array([1, 2]) }, { id: 2 }];
    const head = { metric: 3, level: 1, widthNs: 8 };
    const pieces = [...wrapDataFilePieces('k<', head, 'series', items)];
    expect(pieces.length).toBeGreaterThan(items.length);
    expect(pieces.join('')).toBe(wrapDataFile('k<', { ...head, series: items }));
    expect([...wrapDataFilePieces('k', {}, 'series', [])].join('')).toBe(wrapDataFile('k', { series: [] }));
    expect(() => [...wrapDataFilePieces('k', head, 'series', [{ x: Number.NaN }])]).toThrow(OtelHtmlError);
  });
});

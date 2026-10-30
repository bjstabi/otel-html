import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, inject, test } from 'vitest';
import type { AnyValue } from '../../src/model/anyvalue.js';
import { LogBody, segmentBody } from '../../src/viewer/components/log-body.js';
import { SeverityBadge, SeverityLabel } from '../../src/viewer/components/severity.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const str = (value: string): AnyValue => ({ kind: 'string', value });

describe('segmentBody', () => {
  test('segments key=value and embedded JSON and loses no characters', () => {
    const s = 'card declined: 402 {"decline_code":"x","attempt":1} charge=ch_1 note="a b"';
    const segs = segmentBody(s);
    expect(
      segs
        .map((g) => (g.type === 'kv' ? `${g.key}=${g.value}` : g.type === 'json' ? g.raw : g.text))
        .join(''),
    ).toBe(s);
    expect(segs.filter((g) => g.type === 'json')).toHaveLength(1);
    expect(segs.flatMap((g) => (g.type === 'kv' ? [g.key] : []))).toEqual(['charge', 'note']);
  });

  test('invalid JSON-looking text stays text', () => {
    expect(segmentBody('{"a":').every((g) => g.type === 'text')).toBe(true);
    expect(segmentBody('{not json}').every((g) => g.type === 'text')).toBe(true);
  });

  test('braces inside JSON strings do not unbalance it', () => {
    const segs = segmentBody('x {"a":"}{"} y');
    expect(segs.filter((g) => g.type === 'json')).toHaveLength(1);
  });

  test('keys must start at a word boundary', () => {
    expect(segmentBody('a.b=1 x-y=2').flatMap((g) => (g.type === 'kv' ? [g.key] : []))).toEqual([
      'a.b',
      'x-y',
    ]);
    expect(segmentBody('==x').every((g) => g.type === 'text')).toBe(true);
  });

  test('a quoted value may hold a raw newline; its inner key=value is not split out', () => {
    const s = 'msg="line one\nb=c" next=1';
    const segs = segmentBody(s);
    expect(segs.flatMap((g) => (g.type === 'kv' ? [[g.key, g.value]] : []))).toEqual([
      ['msg', '"line one\nb=c"'],
      ['next', '1'],
    ]);
  });

  test('past the first 256 KiB the rest is one plain-text segment; a pair straddling the cap stays whole', () => {
    const cap = 262_144;
    const s = `${'a'.repeat(cap - 4)} key=value tail k2=v2 {"x":1}`;
    const segs = segmentBody(s);
    expect(
      segs
        .map((g) => (g.type === 'kv' ? `${g.key}=${g.value}` : g.type === 'json' ? g.raw : g.text))
        .join(''),
    ).toBe(s);
    expect(segs.flatMap((g) => (g.type === 'kv' ? [g.key] : []))).toEqual(['key']);
    expect(segs.at(-1)).toEqual({ type: 'text', text: ' tail k2=v2 {"x":1}' });
  });
});

const join = (s: string): string =>
  segmentBody(s)
    .map((g) => (g.type === 'kv' ? `${g.key}=${g.value}` : g.type === 'json' ? g.raw : g.text))
    .join('');

describe('@perf segmentBody cost', () => {
  test.each([
    ['{'.repeat(100_000)],
    ['['.repeat(16_384)],
    ['a="'.repeat(50_000)],
    ['{"a":'.repeat(40_000)],
    ['x'.repeat(1024 * 1024)],
  ])('hostile input of %#, length %d stays fast and lossless', (s) => {
    const t = performance.now();
    const out = join(s);
    expect(performance.now() - t).toBeLessThan(500 * inject('perfFactor'));
    expect(out).toBe(s);
  });
});

describe('LogBody extras', () => {
  test('a JSON-looking but invalid string body renders as text', () => {
    const { container } = render(<LogBody body={str('{"a": nope}')} mode="raw" />);
    expect(container.textContent).toBe('{"a": nope}');
    expect(container.querySelector('.oh-json-num')).toBeNull();
  });

  test('the cut does not split a surrogate pair', () => {
    const { container } = render(<LogBody body={str('ab\u{1F600}cd')} mode="raw" maxChars={3} />);
    expect(container.textContent?.startsWith('ab… ')).toBe(true);
  });
});

describe('LogBody', () => {
  test('hostile bodies render as text', () => {
    const { container } = render(<LogBody body={str('</script><img src=x onerror=alert(1)> ')} mode="raw" />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    // key=value pairs split across styled spans, so assert on the joined text, not one element.
    expect(container.textContent).toBe('</script><img src=x onerror=alert(1)> ');
  });

  test('U+2028 and U+2029 survive as text', () => {
    const { container } = render(<LogBody body={str('a b c')} mode="wrapped" />);
    expect(container.textContent).toBe('a b c');
  });

  test('a 1 MB body is cut to 16 384 chars with a show-all control', async () => {
    const body = 'x'.repeat(1024 * 1024);
    const { container } = render(<LogBody body={str(body)} mode="raw" />);
    expect(container.textContent?.startsWith('x'.repeat(16_384))).toBe(true);
    expect(container.textContent?.includes('x'.repeat(16_385))).toBe(false);
    const btn = screen.getByRole('button', { name: /^Show all \(1 MiB\)$/ });
    await userEvent.setup().click(btn);
    expect(container.textContent?.includes('x'.repeat(1024 * 1024))).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('a JSON body is tokenised into coloured spans', () => {
    const { container } = render(<LogBody body={str('hello {"a":1,"b":"s"}')} mode="wrapped" />);
    expect(container.querySelector('.oh-json-key')?.textContent).toBe('"a"');
    expect(container.querySelector('.oh-json-num')?.textContent).toBe('1');
    expect(container.querySelector('.oh-json-str')?.textContent).toBe('"s"');
  });

  test('map bodies render as a tree, 50 levels deep without a stack overflow', () => {
    let v: AnyValue = { kind: 'string', value: 'leaf' };
    for (let i = 0; i < 50; i++) v = { kind: 'kvlist', values: new Map([[`k${i}`, v]]) };
    const { container } = render(<LogBody body={v} mode="wrapped" />);
    expect(container.querySelector('.oh-json')).not.toBeNull();
    expect(container.textContent).toContain('k49');
  });

  test('array bodies and bytes render', () => {
    render(<LogBody body={{ kind: 'bytes', value: new Uint8Array([104, 105]) }} mode="raw" />);
    expect(screen.getByText('aGk=')).toBeTruthy();
  });

  test('wrapped mode clamps to the line count', () => {
    const { container } = render(<LogBody body={str('a\nb\nc')} mode="wrapped" lines={3} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.webkitLineClamp || el.style.getPropertyValue('-webkit-line-clamp')).toBe('3');
  });
});

describe('severity', () => {
  test('badge pairs label and number, adds differing text', () => {
    render(<SeverityBadge number={17} text="E" />);
    expect(screen.getByText('ERROR · 17')).toBeTruthy();
    expect(screen.getByText('E')).toBeTruthy();
  });

  test('text equal to the band is not repeated', () => {
    render(<SeverityBadge number={17} text="error" />);
    expect(screen.queryByText('error')).toBeNull();
  });

  test('hostile severity text renders as text', () => {
    render(<SeverityBadge number={9} text="<img src=x onerror=alert(1)> " />);
    expect(document.querySelector('img')).toBeNull();
  });

  test('the label alone renders just the band', () => {
    render(<SeverityLabel band="warn" />);
    expect(screen.getByText('WARN')).toBeTruthy();
  });
});

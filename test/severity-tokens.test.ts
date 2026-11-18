import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SEVERITY_DARK, SEVERITY_LIGHT, STATUS } from '../src/viewer/theme/palette.js';

/** `--oh-*` declarations of every block in tokens.css whose selector line matches `selector`. */
function tokens(css: string, selector: RegExp): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const line of css.split('\n')) {
    if (selector.test(line)) inside = true;
    else if (inside && /^\s*\}/.test(line)) inside = false;
    else if (inside) {
      const m = /^\s*(--oh-[a-z0-9-]+):\s*([^;]+);/.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2].trim());
    }
  }
  return out;
}

describe('tokens.css severity tokens', () => {
  const css = readFileSync(new URL('../src/viewer/theme/tokens.css', import.meta.url), 'utf8');
  const light = tokens(css, /^:root \{/);
  const darkAuto = tokens(css, /^\s*:root:not\(\[data-theme="light"\]\)/);
  const darkForced = tokens(css, /^:root\[data-theme="dark"\]/);

  it('matches the light values in palette.ts, with unspecified following the muted ink', () => {
    for (const [k, v] of Object.entries(SEVERITY_LIGHT)) expect(light.get(`--oh-sev-${k}`)).toBe(v);
    expect(light.get('--oh-sev-unspecified')).toBe('var(--oh-muted)');
  });

  it('matches the dark values in palette.ts under both the media query and the forced theme', () => {
    for (const dark of [darkAuto, darkForced]) {
      for (const [k, v] of Object.entries(SEVERITY_DARK)) expect(dark.get(`--oh-sev-${k}`)).toBe(v);
      expect(dark.get('--oh-sev-unspecified')).toBe('var(--oh-muted)');
    }
  });

  it('keeps the surface and muted colours the contrast test assumes', () => {
    expect([light.get('--oh-surface'), light.get('--oh-muted')]).toEqual(['#ffffff', '#6b6f78']);
    for (const dark of [darkAuto, darkForced])
      expect([dark.get('--oh-surface'), dark.get('--oh-muted')]).toEqual(['#1a1a19', '#96958c']);
  });
});

describe('tokens.css good tokens', () => {
  const css = readFileSync(new URL('../src/viewer/theme/tokens.css', import.meta.url), 'utf8');

  it('STATUS.good is --oh-good in all three blocks, and --color-good follows it', () => {
    expect([...css.matchAll(/--oh-good: (#[0-9a-f]+);/g)].map((m) => m[1])).toEqual([
      STATUS.good,
      STATUS.good,
      STATUS.good,
    ]);
    expect(css).toContain('--color-good: var(--oh-good);');
    expect(css.match(/--oh-good-ink: #006300;/g)).toHaveLength(1);
    expect(css.match(/--oh-good-ink: #3ddc3d;/g)).toHaveLength(2);
    expect(css.match(/--oh-ok-cell: #d6e9fb;/g)).toHaveLength(1);
    expect(css.match(/--oh-ok-cell: #23385a;/g)).toHaveLength(2);
  });
});

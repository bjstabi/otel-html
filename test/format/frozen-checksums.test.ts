import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const REPORTS = join(import.meta.dirname, '../../fixtures/reports');
const FROZEN = ['format-1', 'format-2', 'format-3', 'format-4', 'format-5'];

const HOW_TO_FIX =
  'fixtures/reports/* are byte-for-byte frozen (see README); if the change is intended, regenerate SHA256SUMS with the command in the README';

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
}

test('every file under format-*/data matches SHA256SUMS, and nothing is missing or extra', () => {
  const listed = new Map<string, string>();
  for (const line of readFileSync(join(REPORTS, 'SHA256SUMS'), 'utf8').split('\n')) {
    if (line === '') continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) throw new Error(`malformed SHA256SUMS line: ${line}`);
    listed.set(m[2], m[1]);
  }
  const actual = new Map<string, string>();
  for (const dir of FROZEN) {
    for (const rel of filesUnder(join(REPORTS, dir))) {
      const path = `${dir}/${rel.replaceAll('\\', '/')}`;
      actual.set(
        path,
        createHash('sha256')
          .update(readFileSync(join(REPORTS, path)))
          .digest('hex'),
      );
    }
  }
  const changed = [...actual].filter(([p, h]) => listed.has(p) && listed.get(p) !== h).map(([p]) => p);
  const extra = [...actual.keys()].filter((p) => !listed.has(p));
  const missing = [...listed.keys()].filter((p) => !actual.has(p));
  expect({ changed, extra, missing }, HOW_TO_FIX).toEqual({ changed: [], extra: [], missing: [] });
});

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { renderSchemaDoc } from '../../scripts/gen-schema-doc.js';
import {
  FIXED_STATISTICS_COLUMNS,
  SORT_COLUMNS,
  TABLE_COLUMNS,
  TABLES,
} from '../../src/format/parquet/columns.js';

const doc = renderSchemaDoc();

/** The text of the `## <table>` section. */
function section(table: string): string {
  const start = doc.indexOf(`\n## Table \`${table}\`\n`);
  expect(start, `section for ${table}`).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

test('every table section lists each column once, with its type', () => {
  for (const table of TABLES) {
    const text = section(table);
    for (const c of TABLE_COLUMNS[table]) {
      const rows = text.split('\n').filter((l) => l.startsWith(`| \`${c.name}\` |`));
      expect(rows, `${table}.${c.name}`).toHaveLength(1);
    }
    const rowCount = text.split('\n').filter((l) => /^\| `/.test(l)).length;
    expect(rowCount).toBe(TABLE_COLUMNS[table].length);
  }
});

test('sort order and fixed statistics columns are stated per table', () => {
  for (const table of TABLES) {
    const text = section(table);
    expect(text).toContain(`Sorted by: ${SORT_COLUMNS[table].map((c) => `\`${c}\``).join(', ')}`);
    const fixed = FIXED_STATISTICS_COLUMNS[table];
    expect(text).toContain(
      fixed.length === 0
        ? 'Fixed statistics columns: none'
        : `Fixed statistics columns: ${fixed.map((c) => `\`${c}\``).join(', ')}`,
    );
  }
});

test('the source grammar, patterns semantics, delta columns and manifest fields are stated', () => {
  for (const s of [
    'flush:<n>',
    'compact:<first>..<last>',
    'merge:<input>#<n>',
    'oldest first',
    'unique within one Drain lineage',
    '(`cluster_id`, `template`)',
    'combine patterns across partitions by template',
    'delta-temporality',
    '128-bit',
    '`statisticsKeys`',
    '`engine`',
    '`assetsBase`',
    '`partitions`',
    'every counter',
    'exponential histogram',
    'reserved prefixes `job:` and `ci:`',
    '`observed_time_unix_nano` for a row where it is null',
    '`timeMin`',
    '`values`',
  ]) {
    expect(doc, s).toContain(s);
  }
});

test('docs/format/schema.md is the generated text (run mise run gen)', () => {
  expect(readFileSync(new URL('../../docs/format/schema.md', import.meta.url), 'utf8')).toBe(doc);
});

import { readFileSync, writeFileSync } from 'node:fs';
import { buildParserFile } from '@lezer/generator';

const grammar = new URL('../src/ottl/ottl.grammar', import.meta.url);
const { parser, terms } = buildParserFile(readFileSync(grammar, 'utf8'), {
  fileName: 'ottl.grammar',
  moduleStyle: 'es',
  includeNames: false,
});
// tsconfig uses isolatedDeclarations, so the exported parser needs an explicit type.
const typed = parser
  .replace('export const parser = ', 'export const parser: LRParser = ')
  .replace('const spec_Ident = ', 'const spec_Ident: Readonly<Record<string, number | null>> = ')
  .replace('get: (value) =>', 'get: (value: string): number =>');
if (!typed.includes('parser: LRParser') || !typed.includes('value: string'))
  throw new Error('gen-ottl: could not annotate the exported parser');
writeFileSync(new URL('../src/ottl/parser.gen.ts', import.meta.url), typed);
writeFileSync(new URL('../src/ottl/parser.gen.terms.ts', import.meta.url), terms);

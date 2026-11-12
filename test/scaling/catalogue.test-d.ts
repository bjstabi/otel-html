import { expectTypeOf, test } from 'vitest';
import type { CATALOGUE, CatalogueEntry } from '../../src/viewer/data/catalogue.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';

type Covered = (typeof CATALOGUE)[number]['method'];

test('every DataSource method but close has an entry', () => {
  // `manifest` and `epoch` are data the source carries, not requests it makes
  expectTypeOf<Exclude<keyof DataSource, 'close' | 'manifest' | 'epoch'>>().toEqualTypeOf<Covered>();
});

test('the catalogue is a list of entries for consumers', () => {
  expectTypeOf<(typeof CATALOGUE)[number]>().toExtend<CatalogueEntry>();
});

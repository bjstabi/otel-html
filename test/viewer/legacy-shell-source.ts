import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { LegacyDataSource } from '../../src/viewer/data/legacy-data-source.js';

/**
 * The metrics pages still read the legacy source (D11, until 5.5), so their tests mount `Shell` with one. `Shell` takes
 * the format-4 type; the metrics routes hand the object straight on to the pages that read the legacy shape.
 */
export function asShellSource(ds: LegacyDataSource): DataSource {
  return ds as unknown as DataSource;
}

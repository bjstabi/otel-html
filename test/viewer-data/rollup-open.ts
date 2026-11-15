import type { ManifestV4 } from '../../src/format/manifest.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import { type Format4Fixture, openFixtureDb } from '../../test-support/format4-fixture.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export interface Opened {
  ds: DataSource;
  /** The manifest's epoch (absolute nanoseconds). */
  epoch: bigint;
  db: TestDb;
  manifest: ManifestV4;
  close(): void;
}

/**
 * A new data source over the bytes `o` already opened, with its own coordinator: no memo or coordinator cache carries
 * over from another test. Read the requests it made from the index the connector had when the test began.
 */
export function freshSource(o: Opened): DataSource {
  return createDuckDbDataSource({
    engine: mosaicQueryEngine(createCoordinator(o.db.connector, silentLogger), o.db),
    manifest: o.manifest,
  });
}

/** A data source over `f`, with the manifest's epoch moved by `epochShiftNs` (a merge that moved it). */
export async function openLayout(f: Format4Fixture, epochShiftNs = 0n): Promise<Opened> {
  const db = await openFixtureDb(f);
  const epoch = BigInt(f.manifest.epochUnixNano) + epochShiftNs;
  const manifest: ManifestV4 = { ...f.manifest, epochUnixNano: String(epoch) };
  const ds = createDuckDbDataSource({
    engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
    manifest,
  });
  return { ds, epoch, db, manifest, close: () => db.close() };
}

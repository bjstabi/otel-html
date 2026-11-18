import { encodeTable } from '../format/parquet/codec.js';
import type { Row } from '../format/parquet/rows.js';

/**
 * The `cicd.parquet` bytes of `rows` (sorted by trace id, kind and start). Apart from `cicd-rows.ts`, whose row
 * derivation the viewer also runs, so that the viewer bundle does not take the Parquet encoder with it.
 */
export function encodeCicd(rows: readonly Row[], rowGroupRows: number): Uint8Array {
  return encodeTable('cicd', rows, { rowGroupRows });
}

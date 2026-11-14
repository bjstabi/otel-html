/**
 * 5: data lives in Parquet partitions (`data/partitions/<p6>/<table>.parquet`), read through DuckDB-WASM; a partition
 * may also hold rollup files, a file may state `timeEndMax`, and the config may state `viewer.defaultWindow`.
 * Format 4 (the same without those) is no longer read.
 */
export const PARTITION_FORMAT_VERSION = 5;
/** The partition formats this otel-html reads. */
export const READABLE_PARTITION_FORMATS = [5] as const;
/**
 * Versions this otel-html reads. A format-1 report has no gaps and no `ex<k>.js`, and the viewer falls back
 * (measures gaps on level 0, reads `ex.js` at every level); a format-2 report has only whole level and exemplar
 * files, which format 3 still writes for a level that fits one page.
 */
export const CHUNK_READABLE_FORMAT_VERSIONS = [1, 2, 3] as const;
export type FormatVersion = (typeof CHUNK_READABLE_FORMAT_VERSIONS)[number];
/** Every version a manifest may declare; `parseAnyManifest` dispatches on it. Chunk readers use the list above. */
export const READABLE_FORMAT_VERSIONS = [1, 2, 3, 5] as const;

/** The global every data file registers into: `__OH__.push("<key>", <payload>);`. */
export const REGISTRATION_GLOBAL = '__OH__';

/** The D12 message: the viewer, `host` and `upgrade` read format 5 only; `merge` converts a format 1 to 3 report. */
export const oldFormatMessage = (formatVersion: number): string =>
  formatVersion <= 3
    ? `This report is format ${formatVersion}; this viewer reads format 5. \`otel-html merge <report> --out <new>\` converts it.`
    : `This report is format ${formatVersion}; this viewer reads format 5 only, and nothing converts a format ${formatVersion} report.`;

/** What `writer.format: chunks` (or `--format chunks`) now fails with. */
export const CHUNKS_GONE =
  'format 3 (chunks) is no longer written; use local or site (otel-html merge converts an older report)';

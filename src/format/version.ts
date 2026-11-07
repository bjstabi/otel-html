/** 4: data lives in Parquet partitions (`data/partitions/<p6>/<table>.parquet`), read through DuckDB-WASM. */
export const PARTITION_FORMAT_VERSION = 4;
/**
 * Versions this otel-html reads. A format-1 report has no gaps and no `ex<k>.js`, and the viewer falls back
 * (measures gaps on level 0, reads `ex.js` at every level); a format-2 report has only whole level and exemplar
 * files, which format 3 still writes for a level that fits one page.
 */
export const CHUNK_READABLE_FORMAT_VERSIONS = [1, 2, 3] as const;
export type FormatVersion = (typeof CHUNK_READABLE_FORMAT_VERSIONS)[number];
/** Every version a manifest may declare; `parseAnyManifest` dispatches on it. Chunk readers use the list above. */
export const READABLE_FORMAT_VERSIONS = [1, 2, 3, 4] as const;

/** The global every data file registers into: `__OH__.push("<key>", <payload>);`. */
export const REGISTRATION_GLOBAL = '__OH__';

/** The D12 message: the viewer and `upgrade` read format 4 only; `merge` converts an older report. */
export const oldFormatMessage = (formatVersion: number): string =>
  `This report is format ${formatVersion}; this viewer reads format 4. \`otel-html merge <report> --out <new>\` converts it.`;

/** What `writer.format: chunks` (or `--format chunks`) now fails with. */
export const CHUNKS_GONE =
  'format 3 (chunks) is no longer written; use local or site (otel-html merge converts an older report)';

/**
 * On-disk report format version the writer writes. Bumped for changes an older reader cannot read; readers fail fast
 * on a version they do not know. 2: `series.js` carries each series' point gaps and coarse levels have their own
 * `ex<k>.js` exemplar files.
 */
export const FORMAT_VERSION = 2;
/** Versions this otel-html reads: a format-1 report has neither, and the viewer falls back (measures gaps on level 0, reads `ex.js` at every level). */
export const READABLE_FORMAT_VERSIONS = [1, 2] as const;
export type FormatVersion = (typeof READABLE_FORMAT_VERSIONS)[number];

/** The global every data file registers into: `__OH__.push("<key>", <payload>);`. */
export const REGISTRATION_GLOBAL = '__OH__';

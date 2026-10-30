/**
 * On-disk report format version the writer writes. Bumped for changes an older reader cannot read; readers fail fast
 * on a version they do not know. 2: `series.js` carries each series' point gaps and coarse levels have their own
 * `ex<k>.js` exemplar files. 3: a level or exemplar file spanning more than one page of buckets is written per page
 * (`l<k>-<p6>.js`, `ex-<p6>.js`, `ex<k>-<p6>.js`), so a zoomed chart reads only the pages under its window.
 */
export const FORMAT_VERSION = 3;
/**
 * Versions this otel-html reads. A format-1 report has no gaps and no `ex<k>.js`, and the viewer falls back
 * (measures gaps on level 0, reads `ex.js` at every level); a format-2 report has only whole level and exemplar
 * files, which format 3 still writes for a level that fits one page.
 */
export const READABLE_FORMAT_VERSIONS = [1, 2, 3] as const;
export type FormatVersion = (typeof READABLE_FORMAT_VERSIONS)[number];

/** The global every data file registers into: `__OH__.push("<key>", <payload>);`. */
export const REGISTRATION_GLOBAL = '__OH__';

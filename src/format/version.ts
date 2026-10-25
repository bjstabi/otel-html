/** On-disk report format version. Bumped only for incompatible changes; readers fail fast on a mismatch. */
export const FORMAT_VERSION = 1;

/** The global every data file registers into: `__OH__.push("<key>", <payload>);`. */
export const REGISTRATION_GLOBAL = '__OH__';

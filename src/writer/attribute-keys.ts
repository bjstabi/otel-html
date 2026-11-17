import type { ColumnBatch } from '../format/parquet/batch.js';
import type { Attributes } from '../model/anyvalue.js';

/** A file with more distinct attribute keys than this records none (the manifest would grow with the keys). */
export const MAX_ATTRIBUTE_KEYS = 1000;

/**
 * Per attribute key, how many entries of a table's rows hold a scalar value for it. This is what the viewer's
 * `attributeFacetsQuery` counts as a key's `total`: the entry's JSON kind is string, int, double or bool, and its text
 * is not null (every scalar has text, the empty string included). A JSON null (an empty value), an array, a nested
 * attribute set and bytes are not counted; a row without attributes holds no entry. A key whose only values are
 * unscalar is not listed.
 */
export class AttributeKeyCounts {
  #counts = new Map<string, number>();
  /** Set once the counts can only record nothing (too many keys, or a `__proto__` key): they are dropped, and later keys are ignored. */
  #exceeded = false;

  /** The keys held: none once the counts can record nothing. */
  get size(): number {
    return this.#counts.size;
  }

  #bump(key: string, by = 1): void {
    if (this.#exceeded) return;
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + by);
    if (this.#counts.size > MAX_ATTRIBUTE_KEYS || key === '__proto__') this.#drop();
  }

  #drop(): void {
    this.#exceeded = true;
    this.#counts = new Map();
  }

  /** The attributes of one record, before they are stored as JSON. */
  addAttributes(attributes: Attributes): void {
    for (const [key, v] of attributes) {
      if (v.kind === 'string' || v.kind === 'int' || v.kind === 'double' || v.kind === 'bool')
        this.#bump(key);
    }
  }

  /** The stored JSON text of one row's attributes (an object, or the `{"$m": [[key, value], ...]}` form). */
  addJson(text: unknown): void {
    if (typeof text !== 'string') return;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const entries: [unknown, unknown][] = Array.isArray(Reflect.get(parsed, '$m'))
      ? (Reflect.get(parsed, '$m') as unknown[]).map((e) =>
          Array.isArray(e) ? [e[0], e[1]] : [undefined, null],
        )
      : Object.entries(parsed);
    for (const [key, v] of entries) {
      if (typeof key === 'string' && scalarJson(v)) this.#bump(key);
    }
  }

  /** The rows of a decoded `spans` or `logs` chunk. */
  addBatch(batch: ColumnBatch): void {
    const { attributes: cells = [] } = batch.cells;
    for (let i = 0; i < batch.length; i++) this.addJson(cells[i]);
  }

  /** The counts of another set. */
  addCounts(other: AttributeKeyCounts): void {
    if (other.#exceeded) this.#drop();
    else for (const [key, n] of other.#counts) this.#bump(key, n);
  }

  /** The counts another file recorded. */
  addRecord(record: Readonly<Record<string, number>>): void {
    for (const [key, n] of Object.entries(record)) this.#bump(key, n);
  }

  /**
   * The manifest record; undefined when there are more than `MAX_ATTRIBUTE_KEYS` keys, or when one is `__proto__`: the
   * manifest is loaded as a script object literal, where that key sets the prototype and is not an own key, so the
   * record would differ from the scan. Such a report is scanned.
   */
  record(): Record<string, number> | undefined {
    if (this.#exceeded) return undefined;
    return Object.fromEntries([...this.#counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}

/** Whether a stored JSON value is a string, bool, int or double (an object with `$i` or `$d` is the tagged int or double). */
function scalarJson(v: unknown): boolean {
  if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return true;
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return '$i' in v || '$d' in v;
  return false;
}

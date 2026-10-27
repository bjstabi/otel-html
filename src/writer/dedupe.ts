import { OtelHtmlError } from '../model/errors.js';

/** Bounded set of recently seen (trace_id, span_id) pairs with FIFO eviction; covers exporter retries. */
export class DedupeSet {
  readonly #capacity: number;
  readonly #keys = new Set<string>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new OtelHtmlError('invalid-config', {
        path: 'writer.dedupeCapacity',
        expected: 'a positive integer',
        actual: String(capacity),
      });
    }
    this.#capacity = capacity;
  }

  has(traceId: string, spanId: string): boolean {
    return this.#keys.has(traceId + spanId);
  }

  /** Records the pair and returns whether it was already present. Seeing a pair again does not refresh it. */
  seen(traceId: string, spanId: string): boolean {
    const key = traceId + spanId;
    if (this.#keys.has(key)) return true;
    this.#keys.add(key);
    if (this.#keys.size > this.#capacity) {
      const oldest = this.#keys.values().next();
      if (!oldest.done) this.#keys.delete(oldest.value);
    }
    return false;
  }

  get size(): number {
    return this.#keys.size;
  }

  /** Oldest first, so `from(toJSON())` preserves eviction order. */
  toJSON(): string[] {
    return [...this.#keys];
  }

  static from(keys: readonly string[], capacity: number): DedupeSet {
    const set = new DedupeSet(capacity);
    for (const k of keys.slice(Math.max(0, keys.length - capacity))) set.#keys.add(k);
    return set;
  }
}

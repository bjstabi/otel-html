import { ExpHistogram } from './exp-histogram.js';

const SPAN_STATUS_KEYS = ['ok', 'error', 'unset'] as const;
export type SpanStatusKey = (typeof SPAN_STATUS_KEYS)[number];

/** One duration histogram per group; groups past `cap` are not kept and their spans are counted in `dropped`. */
export class GroupDurations {
  readonly #groups = new Map<string, ExpHistogram>();
  readonly cap: number;
  #dropped = 0;

  constructor(cap: number) {
    this.cap = cap;
  }

  /** Spans whose group was refused because `cap` groups were already kept. */
  get dropped(): number {
    return this.#dropped;
  }

  get size(): number {
    return this.#groups.size;
  }

  add(group: string, durationNs: number): void {
    let h = this.#groups.get(group);
    if (h === undefined) {
      if (this.#groups.size >= this.cap) {
        this.#dropped++;
        return;
      }
      h = new ExpHistogram();
      this.#groups.set(group, h);
    }
    h.record(durationNs);
  }

  get(group: string): ExpHistogram | undefined {
    return this.#groups.get(group);
  }

  entries(): IterableIterator<[string, ExpHistogram]> {
    return this.#groups.entries();
  }
}

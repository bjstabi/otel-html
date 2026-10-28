/** A JSON number that is not a safe integer, kept with its exact source text (see `parseJsonText`). */
export class UnsafeNumber {
  readonly value: number;
  readonly source: string;
  constructor(value: number, source: string) {
    this.value = value;
    this.source = source;
  }
}

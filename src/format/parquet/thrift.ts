/**
 * Thrift compact protocol, generic: enough to read a Parquet footer into a tree, change fields in it and write it
 * back. Nothing is interpreted, so a field this module does not know survives the round trip byte for byte (the
 * encoding of a value is canonical, apart from the order fields are written in, which is kept).
 */

/** Compact protocol type ids (a field header's low nibble; a list's element type). */
export const T = {
  True: 1,
  False: 2,
  Byte: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  Double: 7,
  Binary: 8,
  List: 9,
  Set: 10,
  Map: 11,
  Struct: 12,
} as const;

export interface TList {
  readonly elem: number;
  readonly items: TValue[];
}

/** A struct is its fields in order; integers are bigints, binary values bytes, booleans booleans. */
type TValue = boolean | number | bigint | Uint8Array | TList | TField[];

export interface TField {
  readonly id: number;
  readonly type: number;
  value: TValue;
}

function fail(what: string): never {
  throw new Error(`malformed Thrift: ${what}`);
}

class Reader {
  #at = 0;
  constructor(readonly bytes: Uint8Array) {}

  byte(): number {
    const b = this.bytes[this.#at++];
    return b === undefined ? fail('unexpected end') : b;
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.#at + n > this.bytes.length) fail('unexpected end');
    const out = this.bytes.slice(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }

  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      if (shift > 63n) fail('varint too long');
    }
  }

  zigzag(): bigint {
    const n = this.varint();
    return (n >> 1n) ^ -(n & 1n);
  }

  value(type: number): TValue {
    switch (type) {
      case T.True:
        return true;
      case T.False:
        return false;
      case T.Byte:
        return this.byte();
      case T.I16:
      case T.I32:
      case T.I64:
        return this.zigzag();
      case T.Double:
        return this.take(8);
      case T.Binary:
        return this.take(Number(this.varint()));
      case T.List:
      case T.Set: {
        const head = this.byte();
        const elem = head & 15;
        const size = head >> 4 === 15 ? Number(this.varint()) : head >> 4;
        const items: TValue[] = [];
        for (let i = 0; i < size; i++)
          items.push(elem === T.True || elem === T.False ? this.byte() === 1 : this.value(elem));
        return { elem, items };
      }
      case T.Struct:
        return this.struct();
      default:
        return fail(`type ${type}`);
    }
  }

  struct(): TField[] {
    const fields: TField[] = [];
    let last = 0;
    for (;;) {
      const head = this.byte();
      if (head === 0) return fields;
      const delta = head >> 4;
      const type = head & 15;
      const id = delta === 0 ? Number(this.zigzag()) : last + delta;
      last = id;
      fields.push({ id, type, value: this.value(type) });
    }
  }
}

class Writer {
  readonly out: number[] = [];

  byte(b: number): void {
    this.out.push(b & 255);
  }

  bytes(b: Uint8Array): void {
    for (const x of b) this.out.push(x);
  }

  varint(n: bigint): void {
    let rest = BigInt.asUintN(64, n);
    for (;;) {
      const low = Number(rest & 0x7fn);
      rest >>= 7n;
      if (rest === 0n) {
        this.byte(low);
        return;
      }
      this.byte(low | 0x80);
    }
  }

  zigzag(n: bigint): void {
    this.varint((n << 1n) ^ (n >> 63n));
  }

  value(type: number, v: TValue): void {
    switch (type) {
      case T.True:
      case T.False:
        return;
      case T.Byte:
        this.byte(Number(v));
        return;
      case T.I16:
      case T.I32:
      case T.I64:
        this.zigzag(BigInt(v as bigint));
        return;
      case T.Double:
        this.bytes(v as Uint8Array);
        return;
      case T.Binary:
        this.varint(BigInt((v as Uint8Array).length));
        this.bytes(v as Uint8Array);
        return;
      case T.List:
      case T.Set: {
        const { elem, items } = v as TList;
        if (items.length < 15) this.byte((items.length << 4) | elem);
        else {
          this.byte(0xf0 | elem);
          this.varint(BigInt(items.length));
        }
        for (const item of items) {
          if (elem === T.True || elem === T.False) this.byte(item === true ? 1 : 2);
          else this.value(elem, item);
        }
        return;
      }
      case T.Struct:
        this.struct(v as TField[]);
        return;
      default:
        fail(`type ${type}`);
    }
  }

  struct(fields: readonly TField[]): void {
    let last = 0;
    for (const f of fields) {
      const type = f.type === T.True || f.type === T.False ? (f.value === true ? T.True : T.False) : f.type;
      const delta = f.id - last;
      if (delta > 0 && delta <= 15) this.byte((delta << 4) | type);
      else {
        this.byte(type);
        this.zigzag(BigInt(f.id));
      }
      last = f.id;
      this.value(f.type, f.value);
    }
    this.byte(0);
  }
}

/** The struct encoded in `bytes` (which must be exactly the struct). */
export function readStruct(bytes: Uint8Array): TField[] {
  return new Reader(bytes).struct();
}

export function writeStruct(fields: readonly TField[]): Uint8Array {
  const w = new Writer();
  w.struct(fields);
  return Uint8Array.from(w.out);
}

/** The field with `id`, or undefined. */
export function field(fields: readonly TField[], id: number): TField | undefined {
  return fields.find((f) => f.id === id);
}

export type AnyValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'int'; readonly value: bigint }
  | { readonly kind: 'double'; readonly value: number }
  | { readonly kind: 'bytes'; readonly value: Uint8Array }
  | { readonly kind: 'array'; readonly values: readonly AnyValue[] }
  | { readonly kind: 'kvlist'; readonly values: Attributes }
  | { readonly kind: 'empty' };

export type Attributes = ReadonlyMap<string, AnyValue>;

function bytesToBase64(b: Uint8Array): string {
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin);
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

function toJson(v: AnyValue): Json {
  switch (v.kind) {
    case 'string':
    case 'bool':
      return v.value;
    case 'int':
      return v.value >= BigInt(Number.MIN_SAFE_INTEGER) && v.value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(v.value)
        : v.value.toString();
    case 'double':
      return Number.isFinite(v.value) ? v.value : String(v.value);
    case 'bytes':
      return bytesToBase64(v.value);
    case 'array':
      return v.values.map(toJson);
    case 'kvlist': {
      const o: Record<string, Json> = {};
      for (const [k, x] of v.values) o[k] = toJson(x);
      return o;
    }
    case 'empty':
      return null;
  }
}

/** Plain JSON for display trees (bigints beyond the safe range and non-finite doubles become strings). */
export function anyValueToJson(v: AnyValue): unknown {
  return toJson(v);
}

export function anyValueToDisplay(v: AnyValue): string {
  switch (v.kind) {
    case 'string':
      return v.value;
    case 'bool':
      return v.value ? 'true' : 'false';
    case 'int':
      return v.value.toString();
    case 'double':
      return String(v.value);
    case 'bytes':
      return bytesToBase64(v.value);
    case 'array':
    case 'kvlist':
      return JSON.stringify(toJson(v));
    case 'empty':
      return '';
  }
}

export function anyValueEquals(a: AnyValue, b: AnyValue): boolean {
  switch (a.kind) {
    case 'string':
    case 'bool':
    case 'int':
      return b.kind === a.kind && a.value === b.value;
    case 'double':
      return b.kind === 'double' && Object.is(a.value, b.value);
    case 'bytes':
      return (
        b.kind === 'bytes' && a.value.length === b.value.length && a.value.every((x, i) => x === b.value[i])
      );
    case 'array':
      return (
        b.kind === 'array' &&
        a.values.length === b.values.length &&
        a.values.every((x, i) => {
          const y = b.values[i];
          return y !== undefined && anyValueEquals(x, y);
        })
      );
    case 'kvlist': {
      if (b.kind !== 'kvlist' || a.values.size !== b.values.size) return false;
      for (const [k, x] of a.values) {
        const y = b.values.get(k);
        if (y === undefined || !anyValueEquals(x, y)) return false;
      }
      return true;
    }
    case 'empty':
      return b.kind === 'empty';
  }
}

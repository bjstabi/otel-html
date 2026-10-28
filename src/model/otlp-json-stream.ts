import { OtelHtmlError } from './errors.js';
import {
  describe,
  fail,
  noSignal,
  type OtlpRequest,
  parseJsonText,
  requestOf,
  type SignalEntry,
  signalEntry,
} from './otlp-json.js';

/** Where the reader is in the outer structure of a document (an OTLP-JSON object). */
type Phase =
  | 'between' // before a document, or between documents: whitespace, then `{`
  | 'first-key' // after `{`: a key or `}`
  | 'next-key' // after `,` between members: a key
  | 'colon' // after a key: `:`
  | 'value' // after `:`: the member's value
  | 'first-element' // after the `[` of a signal array: an element or `]`
  | 'next-element' // after `,` in a signal array: an element
  | 'after-element' // `,` or `]`
  | 'after-member' // `,` or `}`
  | 'capture'; // inside a value whose text is being collected

/** What a captured value is, and so what happens once it is complete. */
type Capture = 'key' | 'element' | 'other-member' | 'signal-member';

// Sticky searches: `lastIndex` is set before every use and never relied on across calls.
/** A string start and the four brackets: what a capture outside a string stops at. */
const STRUCTURE = /["[\]{}]/g;
/** A quote or a backslash: what a capture inside a string stops at. */
const STRING_STOP = /["\\]/g;
/** Where a number, `true`, `false` or `null` ends. */
const PRIMITIVE_END = /[ \t\n\r,\]}]/g;

function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

/** The JSON type a value starting with `c` would have, other than object; null if none can start so. */
function rootKind(c: string): string | null {
  if (c === '[') return 'array';
  if (c === '"') return 'string';
  if (c === 't' || c === 'f') return 'boolean';
  if (c === 'n') return 'null';
  if (c === '-' || (c >= '0' && c <= '9')) return 'number';
  return null;
}

function countNewlines(text: string, from: number, end: number): number {
  let n = 0;
  for (let i = text.indexOf('\n', from); i >= 0 && i < end; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

export interface OtlpJsonStreamOptions {
  /**
   * JSON lines: every document is named `<source>:<line>` in errors, and an input without any document is valid.
   * Otherwise the first document is named `<source>`, later ones (JSON lines without the extension)
   * `<source>:<line>`, and an input without any document is an error.
   */
  readonly lines: boolean;
}

/**
 * Reads OTLP JSON pushed in pieces of any size, one resource entry at a time: each element of a top-level
 * `resourceSpans`, `resourceLogs` or `resourceMetrics` array becomes its own request as soon as its last character
 * arrives, so neither the whole text nor the whole object tree is ever held. The input is one or more objects
 * separated by whitespace (a JSON file, or JSON lines).
 *
 * Only the outer structure is walked here. Each element (and each other member's value) is handed whole to
 * `JSON.parse` with the same int64-preserving reviver and conversion as `parseOtlpJson`, which also validates it;
 * error paths keep the element's index (`resourceLogs[3].…`). Requests come in input order, and an empty signal
 * array gives one empty request. Requests already returned stay valid when a later error is found.
 */
export class OtlpJsonStream {
  readonly #source: string;
  readonly #lines: boolean;
  #phase: Phase = 'between';
  /** Characters consumed before the current piece. */
  #offset = 0;
  /** The line at index `#counted` of the current piece. */
  #line = 1;
  #counted = 0;
  #documents = 0;
  /** The current document's name in errors. */
  #label: string;
  /** Signal members seen in the current document. */
  #signals = 0;
  #key = '';
  #entry: SignalEntry | null = null;
  #element = 0;
  // The value being captured: its kind, its text so far, where it starts, and the scan state.
  #capture: Capture = 'key';
  #parts: string[] = [];
  #start = 0;
  #depth = 0;
  #inString = false;
  #escape = false;
  #primitive = false;

  constructor(source: string, options: OtlpJsonStreamOptions) {
    this.#source = source;
    this.#lines = options.lines;
    this.#label = source;
  }

  /** Feed the next piece of text; returns the requests it completed. */
  push(text: string): OtlpRequest[] {
    const out: OtlpRequest[] = [];
    let i = 0;
    for (;;) {
      // A capture runs even at the end of the piece, to keep the text it has started.
      if (this.#phase === 'capture') {
        const from = Math.max(0, this.#start - this.#offset);
        const end = this.#scan(text, i);
        if (end < 0) {
          this.#parts.push(text.slice(from));
          break;
        }
        this.#parts.push(text.slice(from, end));
        this.#complete(out);
        i = end;
      } else if (i >= text.length) {
        break;
      } else if (isWhitespace(text.charCodeAt(i))) {
        i++;
      } else {
        i = this.#structural(text, i, out);
      }
    }
    this.#line += countNewlines(text, this.#counted, text.length);
    this.#counted = 0;
    this.#offset += text.length;
    return out;
  }

  /** End the input; throws if it stopped inside a document, or held none (unless reading JSON lines). */
  end(): void {
    if (this.#phase !== 'between') throw this.#syntax('unexpected end of input', null);
    if (this.#documents === 0 && !this.#lines) {
      throw new OtelHtmlError('invalid-otlp', {
        message: `${this.#source}: invalid JSON: no JSON object found`,
      });
    }
  }

  /** Handles the non-whitespace character at `i` outside any capture; returns where to continue. */
  #structural(text: string, i: number, out: OtlpRequest[]): number {
    const c = text.charAt(i);
    const at = this.#offset + i;
    switch (this.#phase) {
      case 'between': {
        const kind = rootKind(c);
        if (c === '{' || kind !== null || this.#lines) {
          this.#line += countNewlines(text, this.#counted, i);
          this.#counted = i;
          this.#label = this.#lines || this.#documents > 0 ? `${this.#source}:${this.#line}` : this.#source;
        } else this.#label = this.#source;
        if (kind !== null) {
          throw new OtelHtmlError('invalid-otlp', {
            message: `${this.#label}: expected a JSON object, got ${kind}`,
          });
        }
        if (c !== '{') throw this.#syntax(`unexpected character ${JSON.stringify(c)}`, at);
        this.#documents++;
        this.#signals = 0;
        this.#phase = 'first-key';
        return i + 1;
      }
      case 'first-key':
        if (c === '}') {
          this.#endDocument();
          return i + 1;
        }
        return this.#begin('key', c, i);
      case 'next-key':
        return this.#begin('key', c, i);
      case 'colon':
        if (c !== ':') throw this.#syntax("expected ':'", at);
        this.#phase = 'value';
        return i + 1;
      case 'value':
        this.#entry = signalEntry(this.#key) ?? null;
        if (this.#entry === null) return this.#begin('other-member', c, i);
        this.#signals++;
        if (c !== '[') return this.#begin('signal-member', c, i);
        this.#element = 0;
        this.#phase = 'first-element';
        return i + 1;
      case 'first-element':
        if (c === ']') {
          out.push(requestOf(this.#signal(), [], 0, this.#label));
          this.#phase = 'after-member';
          return i + 1;
        }
        return this.#begin('element', c, i);
      case 'next-element':
        return this.#begin('element', c, i);
      case 'after-element':
        if (c === ',') this.#phase = 'next-element';
        else if (c === ']') this.#phase = 'after-member';
        else throw this.#syntax("expected ',' or ']'", at);
        return i + 1;
      case 'after-member':
        if (c === ',') this.#phase = 'next-key';
        else if (c === '}') this.#endDocument();
        else throw this.#syntax("expected ',' or '}'", at);
        return i + 1;
      case 'capture':
        throw new Error('invariant violated: structural character inside a capture');
      default: {
        const unknown: never = this.#phase;
        throw new Error(`invariant violated: unknown phase ${String(unknown)}`);
      }
    }
  }

  /** Starts capturing the value whose first character `c` is at `i`; returns where its scan continues. */
  #begin(capture: Capture, c: string, i: number): number {
    if (capture === 'key' && c !== '"') {
      throw this.#syntax('expected a property name in double quotes', this.#offset + i);
    }
    this.#phase = 'capture';
    this.#capture = capture;
    this.#parts = [];
    this.#start = this.#offset + i;
    this.#inString = c === '"';
    this.#escape = false;
    this.#depth = c === '{' || c === '[' ? 1 : 0;
    this.#primitive = !this.#inString && this.#depth === 0;
    return i + 1;
  }

  /** Scans the captured value from `i`; returns the index just past its end, or -1 if it goes on past `text`. */
  #scan(text: string, from: number): number {
    let i = from;
    for (;;) {
      if (this.#inString) {
        if (this.#escape) {
          if (i >= text.length) return -1;
          this.#escape = false;
          i++;
          continue;
        }
        STRING_STOP.lastIndex = i;
        const m = STRING_STOP.exec(text);
        if (m === null) return -1;
        i = m.index + 1;
        if (m[0] === '\\') this.#escape = true;
        else {
          this.#inString = false;
          if (this.#depth === 0) return i;
        }
        continue;
      }
      if (this.#primitive) {
        PRIMITIVE_END.lastIndex = i;
        return PRIMITIVE_END.exec(text)?.index ?? -1;
      }
      STRUCTURE.lastIndex = i;
      const m = STRUCTURE.exec(text);
      if (m === null) return -1;
      i = m.index + 1;
      const ch = m[0];
      if (ch === '"') this.#inString = true;
      else if (ch === '{' || ch === '[') this.#depth++;
      else if (--this.#depth === 0) return i;
    }
  }

  /** The captured value is complete: parse it and act on it. */
  #complete(out: OtlpRequest[]): void {
    const text = this.#parts.length === 1 ? (this.#parts[0] ?? '') : this.#parts.join('');
    this.#parts = [];
    const label = this.#label;
    const where = (what: string): string => ` in ${what} at position ${this.#start}`;
    switch (this.#capture) {
      case 'key': {
        const key = parseJsonText(text, label, where('a property name'));
        if (typeof key !== 'string') throw this.#syntax('expected a property name', this.#start);
        this.#key = key;
        this.#phase = 'colon';
        return;
      }
      case 'element': {
        const path = `${this.#key}[${this.#element}]`;
        const resource = parseJsonText(text, label, where(path));
        out.push(requestOf(this.#signal(), [resource], this.#element, label));
        this.#element++;
        this.#phase = 'after-element';
        return;
      }
      case 'other-member':
        parseJsonText(text, label, where(this.#key)); // validated, then ignored
        this.#phase = 'after-member';
        return;
      case 'signal-member':
        fail(label, this.#key, 'array', describe(parseJsonText(text, label, where(this.#key))));
        return;
      default: {
        const unknown: never = this.#capture;
        throw new Error(`invariant violated: unknown capture ${String(unknown)}`);
      }
    }
  }

  #signal(): SignalEntry {
    if (this.#entry === null) throw new Error('invariant violated: signal array without a signal');
    return this.#entry;
  }

  #endDocument(): void {
    if (this.#signals === 0) throw noSignal(this.#label);
    this.#phase = 'between';
  }

  /** `at` null: the end of the input. */
  #syntax(what: string, at: number | null): OtelHtmlError {
    const where = at === null ? 'at the end of the input' : `at position ${at}`;
    return new OtelHtmlError('invalid-otlp', { message: `${this.#label}: invalid JSON: ${what} ${where}` });
  }
}

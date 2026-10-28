import { OtelHtmlError } from './errors.js';
import type { OtlpRequest } from './otlp-json.js';
import { OtlpJsonStream } from './otlp-json-stream.js';
import { streamOtlpProtobuf } from './otlp-proto.js';

function extension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Turns a file's bytes, piece by piece, into requests. */
interface Decoder {
  push(bytes: Uint8Array): Iterable<OtlpRequest>;
  end(): Iterable<OtlpRequest>;
}

function jsonDecoder(fileName: string, lines: boolean): Decoder {
  const text = new TextDecoder(); // drops a leading BOM
  const json = new OtlpJsonStream(fileName, { lines });
  return {
    push: (bytes) => json.push(text.decode(bytes, { stream: true })),
    end: () => {
      const out = json.push(text.decode());
      json.end();
      return out;
    },
  };
}

/** Protobuf is decoded once the whole message is in, still one resource entry at a time. */
function protobufDecoder(fileName: string, signal: OtlpRequest['signal']): Decoder {
  const parts: Uint8Array[] = [];
  return {
    push: (bytes) => {
      parts.push(bytes);
      return [];
    },
    end: () => streamOtlpProtobuf(concat(parts.splice(0)), signal, fileName),
  };
}

/** Picks the decoder from the first bytes (at least two, unless the file is shorter) and the file name. */
function decoderFor(head: Uint8Array, fileName: string, signalHint?: OtlpRequest['signal']): Decoder {
  if (head[0] === 0x1f && head[1] === 0x8b) {
    throw new OtelHtmlError('unsupported-input', {
      path: fileName,
      expected: 'uncompressed OTLP input',
      actual: 'gzip data',
      hint: 'gunzip first',
    });
  }
  const ext = extension(fileName);
  if (ext === '.pb' || ext === '.binpb') {
    if (signalHint === undefined) {
      throw new OtelHtmlError('usage', {
        path: fileName,
        expected: 'a signal hint for protobuf input',
        actual: 'none',
        hint: 'pass --signal traces|logs|metrics',
      });
    }
    return protobufDecoder(fileName, signalHint);
  }
  // A plain JSON file may also hold several objects (JSON lines without the extension); see OtlpJsonStream.
  return jsonDecoder(fileName, ext === '.jsonl' || ext === '.ndjson');
}

/**
 * Reads one OTLP input file (JSON, JSON lines or protobuf), given as pieces of its bytes, into requests one
 * resource entry at a time (see `OtlpJsonStream`), so a large file is never held whole as text or as objects.
 */
export async function* readOtlpFile(
  pieces: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  fileName: string,
  signalHint?: OtlpRequest['signal'],
): AsyncGenerator<OtlpRequest, void, undefined> {
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let decoder: Decoder | null = null;
  for await (const piece of pieces) {
    if (decoder !== null) {
      yield* decoder.push(piece);
      continue;
    }
    head.push(piece);
    headBytes += piece.length;
    if (headBytes >= 2) {
      const first = concat(head.splice(0));
      decoder = decoderFor(first, fileName, signalHint);
      yield* decoder.push(first);
    }
  }
  if (decoder === null) {
    const first = concat(head);
    decoder = decoderFor(first, fileName, signalHint);
    yield* decoder.push(first);
  }
  yield* decoder.end();
}

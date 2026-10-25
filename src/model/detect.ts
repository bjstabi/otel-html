import { OtelHtmlError } from './errors.js';
import { parseJsonLines } from './jsonl.js';
import { type OtlpRequest, parseOtlpJson } from './otlp-json.js';
import { parseOtlpProtobuf } from './otlp-proto.js';

function extension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}

function firstLineIsCompleteJson(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const [first] = lines;
  if (first === undefined || lines.length < 2) return false;
  try {
    JSON.parse(first);
    return true;
  } catch {
    return false;
  }
}

/** Reads one OTLP input file (JSON, JSON lines or protobuf) into requests. */
export function readOtlpFile(
  bytes: Uint8Array,
  fileName: string,
  signalHint?: OtlpRequest['signal'],
): OtlpRequest[] {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
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
    return [parseOtlpProtobuf(bytes, signalHint, fileName)];
  }
  const text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
  if (ext === '.jsonl' || ext === '.ndjson' || firstLineIsCompleteJson(text)) {
    return parseJsonLines(text, fileName);
  }
  return parseOtlpJson(text, fileName);
}

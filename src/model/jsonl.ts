import type { OtlpRequest } from './otlp-json.js';
import { OtlpJsonStream } from './otlp-json-stream.js';

/**
 * One OTLP JSON object per line (the collector file exporter format), one request per resource entry; blank lines
 * are skipped and errors name the line (`<source>:<line>`).
 */
export function parseJsonLines(text: string, source: string): OtlpRequest[] {
  const stream = new OtlpJsonStream(source, { lines: true });
  const out = stream.push(text);
  stream.end();
  return out;
}

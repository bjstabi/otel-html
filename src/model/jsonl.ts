import { type OtlpRequest, parseOtlpJson } from './otlp-json.js';

/** One OTLP JSON object per line (the collector file exporter format); blank lines are skipped. */
export function parseJsonLines(text: string, source: string): OtlpRequest[] {
  const out: OtlpRequest[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line !== '') out.push(...parseOtlpJson(line, `${source}:${i + 1}`));
  }
  return out;
}

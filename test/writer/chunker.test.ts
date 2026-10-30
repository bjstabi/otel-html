import { expect, test } from 'vitest';
import { ChunkBuffer, SPAN_SIGNAL } from '../../src/writer/chunker.js';
import { realisticSpans } from '../../test-support/otlp-builders.js';

test('pendingKey is the same string instance until the chunk is cut', () => {
  const f = realisticSpans(1);
  const buf = new ChunkBuffer(SPAN_SIGNAL, 0);
  const a = buf.pendingKey;
  expect(Object.is(buf.pendingKey, a)).toBe(true);
  const span = f.spans[0];
  if (span === undefined) throw new Error('no span');
  buf.push(span);
  const built = buf.build(f.resources, f.scopes);
  if (built === null) throw new Error('nothing built');
  buf.commit(built);
  expect(buf.pendingKey).toBe('chunks/spans/000001');
  expect(Object.is(buf.pendingKey, buf.pendingKey)).toBe(true);
});

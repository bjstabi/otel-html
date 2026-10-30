import { expect, test } from 'vitest';
import { ChunkBuffer, SPAN_SIGNAL } from '../../src/writer/chunker.js';
import { realisticSpans } from '../../test-support/otlp-builders.js';

// That the key is one shared instance is not observable in JS (strings compare by value); the load test measures it.
test('pendingKey follows the chunk number across a cut', () => {
  const f = realisticSpans(1);
  const buf = new ChunkBuffer(SPAN_SIGNAL, 0);
  expect(buf.pendingKey).toBe('chunks/spans/000000');
  const span = f.spans[0];
  if (span === undefined) throw new Error('no span');
  buf.push(span);
  const built = buf.build(f.resources, f.scopes);
  if (built === null) throw new Error('nothing built');
  buf.commit(built);
  expect(buf.pendingKey).toBe('chunks/spans/000001');
});

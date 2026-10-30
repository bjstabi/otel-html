import { type DescMessage, isMessage, type MessageShape } from '@bufbuild/protobuf';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { Receiver } from '../src/receiver/receiver.js';

/** Narrows a gRPC client response to the message `schema` describes, failing loudly when it is not one. */
export function decodeResponse<D extends DescMessage>(schema: D, res: unknown): MessageShape<D> {
  if (!isMessage(res, schema)) throw new Error(`response is not a ${schema.typeName}`);
  return res;
}

/** A `receive` for a server under test that must never reach it. */
export const unusedReceive: Receiver['receive'] = async () => {
  throw new Error('receive was not expected to be called');
};

/** A real, ended `ReadableSpan` as the SDK hands exporters, captured with the SDK's in-memory exporter. */
export function readableSpan(name: string): ReadableSpan {
  const memory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
  provider.getTracer('t').startSpan(name).end();
  const [captured] = memory.getFinishedSpans();
  if (captured === undefined) throw new Error('the SDK captured no span');
  return captured;
}

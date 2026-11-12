import type { ProxyTracerProvider, Span, TimeInput, Tracer, TracerProvider } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';

/**
 * A clock captured when this module loads, before any test can call `vi.useFakeTimers` or `vi.setSystemTime`. The SDK's
 * own clock reads `Date.now` and `performance.now` at the moment a span starts or ends, so a test that fakes them
 * stamps its spans (and vitest's own spans around it) with the fake time. Passing these as explicit start and end times
 * keeps every span on the real timeline.
 */
const realDateNow = Date.now.bind(Date);
const realPerformanceNow = performance.now.bind(performance);
const originMs = realDateNow() - realPerformanceNow();

/** Epoch milliseconds from the real clock (fractional, monotonic within the process). */
function realNowMs(): number {
  return originMs + realPerformanceNow();
}

const patched = new WeakSet<object>();

/** Makes `tracer` stamp spans from the real clock unless the caller passes a time. Idempotent; returns `tracer`. */
export function withRealClock(tracer: Tracer): Tracer {
  if (patched.has(tracer)) return tracer;
  patched.add(tracer);
  const startSpan = tracer.startSpan.bind(tracer);
  tracer.startSpan = (name, options, context) => {
    const span: Span = startSpan(name, { ...options, startTime: options?.startTime ?? realNowMs() }, context);
    const end = span.end.bind(span);
    span.end = (endTime?: TimeInput) => end(endTime ?? realNowMs());
    return span;
  };
  return tracer;
}

/**
 * Wraps the global provider's `getTracer`, so tracers made from now on (vitest's own among them) use the real clock.
 * Call it after the SDK registered its provider. A tracer made earlier is patched when `withRealClock` sees it.
 */
export function patchGlobalTracersToRealClock(): void {
  const delegate: TracerProvider = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();
  if (delegate.constructor.name === 'NoopTracerProvider' || patched.has(delegate)) return;
  patched.add(delegate);
  const getTracer = delegate.getTracer.bind(delegate);
  delegate.getTracer = (...args) => withRealClock(getTracer(...args));
}

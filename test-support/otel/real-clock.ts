import {
  ProxyTracerProvider,
  type Span,
  type TimeInput,
  type Tracer,
  type TracerProvider,
  trace,
} from '@opentelemetry/api';

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
    // Once a start time is given the SDK stamps an untimed event from Date.now(), which a test may have faked.
    const addEvent = span.addEvent.bind(span);
    span.addEvent = (eventName, attributesOrStartTime, startTime) => {
      const timed = isTimeInput(attributesOrStartTime);
      return addEvent(
        eventName,
        attributesOrStartTime,
        timed || startTime !== undefined ? startTime : realNowMs(),
      );
    };
    return span;
  };
  return tracer;
}

function isTimeInput(value: unknown): value is TimeInput {
  return typeof value === 'number' || value instanceof Date || Array.isArray(value);
}

/** The provider behind the global API's proxy, or undefined while none is registered (or the proxy is not the API's). */
export function globalProvider(): TracerProvider | undefined {
  const proxy = trace.getTracerProvider();
  return proxy instanceof ProxyTracerProvider ? proxy.getDelegate() : undefined;
}

/**
 * Wraps the global provider's `getTracer`, so tracers made from now on (vitest's own among them) use the real clock.
 * `before` is what `globalProvider()` returned before the SDK started: when it is still the one in place (nothing
 * registered, or a registration refused) there is nothing new to patch. A tracer made earlier is patched when
 * `withRealClock` sees it.
 */
export function patchGlobalTracersToRealClock(before: TracerProvider | undefined): void {
  const delegate = globalProvider();
  if (delegate === undefined || delegate === before || patched.has(delegate)) return;
  patched.add(delegate);
  const getTracer = delegate.getTracer.bind(delegate);
  delegate.getTracer = (...args) => withRealClock(getTracer(...args));
}

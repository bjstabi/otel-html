import {
  type ContextManager,
  context,
  type ProxyTracerProvider,
  propagation,
  type TextMapPropagator,
  type TracerProvider,
  trace,
} from '@opentelemetry/api';

/** The key the OpenTelemetry API keeps its global state under (the API's major version is part of it). */
const API_GLOBAL = Symbol.for('opentelemetry.js.api.1');

interface ApiSlots {
  context?: ContextManager;
  propagation?: TextMapPropagator;
}

function apiSlots(): ApiSlots | undefined {
  const holder: Record<symbol, ApiSlots | undefined> = globalThis;
  return holder[API_GLOBAL];
}

/**
 * Runs `fn` with no global tracer provider, context manager or propagator registered, so a test can register its own,
 * then unregisters what `fn` registered and puts the earlier three back, also when `fn` throws.
 *
 * Under an endpoint vitest registers its own three in the worker and starts its test spans through them. The public
 * API cannot read the registered context manager or propagator, so they are taken from the API's global object. They
 * must not be released with `context.disable()`: that calls `disable()` on vitest's `AsyncLocalStorageContextManager`,
 * which exits every in-flight context for good and turns each later vitest span in the worker into a root. The
 * instances are taken out of their slot instead and put back as they were. Call it inside the test body, not in hooks:
 * vitest starts its `test.callback` and `test.afterEach` spans between the hooks.
 */
export async function withOwnOtelGlobals<T>(fn: () => T | Promise<T>): Promise<T> {
  const slots = apiSlots();
  const manager = slots?.context;
  const propagator = slots?.propagation;
  const delegate: TracerProvider = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();
  const provider = delegate.constructor.name === 'NoopTracerProvider' ? undefined : delegate;
  trace.disable();
  propagation.disable();
  if (slots !== undefined) delete slots.context;
  try {
    return await fn();
  } finally {
    trace.disable();
    context.disable();
    propagation.disable();
    if (provider !== undefined) trace.setGlobalTracerProvider(provider);
    if (manager !== undefined) context.setGlobalContextManager(manager);
    if (propagator !== undefined) propagation.setGlobalPropagator(propagator);
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Context,
  type ContextManager,
  context,
  createContextKey,
  type ProxyTracerProvider,
  propagation,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { expect, test } from 'vitest';
import { withOwnOtelGlobals } from '../../test-support/otel/own-globals.js';

/** A context manager like the real one: `disable()` exits every in-flight context. */
function ownManager(): ContextManager {
  const als = new AsyncLocalStorage<Context>();
  const manager: ContextManager = {
    active: () => als.getStore() ?? ROOT_CONTEXT,
    with: (ctx, fn, thisArg, ...args) => als.run(ctx, () => fn.call(thisArg, ...args)),
    bind: (_ctx, target) => target,
    enable: () => manager,
    disable: () => {
      als.disable();
      return manager;
    },
  };
  return manager;
}

test('the registered context manager keeps its in-flight context and comes back', async () => {
  const key = createContextKey('own-globals');
  // A manager is registered for the test even when vitest's tracing is off and registered none.
  await withOwnOtelGlobals(async () => {
    context.setGlobalContextManager(ownManager());
    await context.with(context.active().setValue(key, 1), async () => {
      await withOwnOtelGlobals(async () => {
        expect(context.active()).toBe(ROOT_CONTEXT); // nothing is registered inside
        expect(context.setGlobalContextManager(ownManager())).toBe(true); // so a test can register its own
        await Promise.resolve();
      });
      await Promise.resolve();
      expect(context.active().getValue(key)).toBe(1);
    });
  });
});

test('the tracer provider and the propagator come back, also after a throw', async () => {
  const provider = new BasicTracerProvider();
  const propagator = new W3CTraceContextPropagator();
  // inside an outer withOwnOtelGlobals, so this test owns the three globals it registers
  await withOwnOtelGlobals(async () => {
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(propagator);
    await expect(
      withOwnOtelGlobals(() => {
        expect((trace.getTracerProvider() as ProxyTracerProvider).getDelegate()).not.toBe(provider);
        expect(propagation.fields()).toEqual([]);
        trace.setGlobalTracerProvider(new BasicTracerProvider());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((trace.getTracerProvider() as ProxyTracerProvider).getDelegate()).toBe(provider);
    expect(propagation.fields()).toEqual(propagator.fields());
  });
});

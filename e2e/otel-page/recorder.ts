import {
  type Context,
  type ContextManager,
  context,
  ROOT_CONTEXT,
  type SpanContext,
  trace,
} from '@opentelemetry/api';
import { BasicTracerProvider, type ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { RECORDER_BINDING, type SpanJson, toSpanJson } from './span-json.js';

/**
 * Bundled for the browser (`mise run e2e:otel-recorder`) and installed on a test's browser context. It registers a
 * tracer provider in the page, through the same `@opentelemetry/api` global slot the viewer reads, and hands each
 * finished span as JSON to the binding the Playwright worker exposed. The parent span context (the test's span) is
 * set on `globalThis` by the line the worker prepends to this bundle.
 */
declare global {
  var __otelHtmlParent: SpanContext | undefined;
}

const parentSpanContext = globalThis.__otelHtmlParent;

/** A stack-based context manager whose bottom is the test span's context, so root spans become its children. */
class StackContextManager implements ContextManager {
  private readonly stack: Context[] = [];
  constructor(private readonly base: Context) {}
  active(): Context {
    return this.stack.at(-1) ?? this.base;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    this.stack.push(ctx);
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.stack.pop();
    }
  }
  bind<T>(ctx: Context, target: T): T {
    if (typeof target !== 'function') return target;
    const manager = this;
    const bound = function (this: unknown, ...args: unknown[]): unknown {
      return manager.with(ctx, () => target.apply(this, args));
    };
    return bound as T;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.stack.length = 0;
    return this;
  }
}

type Binding = (span: SpanJson) => unknown;

function send(span: ReadableSpan): void {
  const binding: unknown = Reflect.get(globalThis, RECORDER_BINDING);
  if (typeof binding !== 'function') return;
  const bound: Binding = binding.bind(globalThis);
  try {
    void Promise.resolve(bound(toSpanJson(span))).catch(() => undefined);
  } catch {
    // A recording failure must never reach the viewer.
  }
}

if (parentSpanContext !== undefined) {
  const base = trace.setSpanContext(ROOT_CONTEXT, parentSpanContext);
  context.setGlobalContextManager(new StackContextManager(base));
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({
        export(spans, done) {
          for (const span of spans) send(span);
          done({ code: 0 });
        },
        shutdown: () => Promise.resolve(),
      }),
    ],
  });
  trace.setGlobalTracerProvider(provider);
}

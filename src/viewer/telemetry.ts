import { type Attributes, type Span, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';

/**
 * The viewer's spans go through `@opentelemetry/api` only: without a registered provider every call is a no-op,
 * so a shipped report carries no SDK and makes no network call. Looked up per call so a provider registered after
 * this module loaded (a test page's recorder) is still used.
 */
export const viewerTracer = (): Tracer => trace.getTracer('otel-html-viewer');

/** Run `fn` inside an active span; a rejection is recorded as an exception and ERROR, then rethrown. */
export function traced<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return viewerTracer().startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      return await fn(span);
    } catch (e: unknown) {
      span.recordException(e instanceof Error ? e : String(e));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** A zero-duration `viewer.navigate` span per hash change: the route and the parameter names, never the values. */
export function watchNavigation(win: Window): () => void {
  const onChange = (): void => {
    const hash = win.location.hash.replace(/^#/, '');
    const qi = hash.indexOf('?');
    const route = qi >= 0 ? hash.slice(0, qi) : hash;
    const names = qi >= 0 ? [...new Set(new URLSearchParams(hash.slice(qi + 1)).keys())].sort() : [];
    viewerTracer()
      .startSpan('viewer.navigate', {
        attributes: { 'otel_html.route': route, 'otel_html.route.params': names.join(',') },
      })
      .end();
  };
  win.addEventListener('hashchange', onChange);
  return () => win.removeEventListener('hashchange', onChange);
}

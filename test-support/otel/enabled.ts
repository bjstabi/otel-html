type Env = Readonly<Record<string, string | undefined>>;

/** True when an OTLP traces endpoint is configured (generic or traces-specific). Dependency-free: vitest.config.ts imports it. */
export function hasEndpoint(env: Env): boolean {
  const { OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT } = env;
  return Boolean(OTEL_EXPORTER_OTLP_ENDPOINT) || Boolean(OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

/** True when an OTLP endpoint is configured and the SDK is not disabled. */
export function tracingEnabled(env: Env): boolean {
  const { OTEL_SDK_DISABLED } = env;
  return hasEndpoint(env) && OTEL_SDK_DISABLED !== 'true';
}

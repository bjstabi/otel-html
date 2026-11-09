export interface EnvBinding {
  readonly env: string;
  readonly path: string;
  readonly parse: 'string' | 'int';
}

/** Environment variables bound to config paths. OTEL_HTML_CONFIG is read by `findConfigPath`, not bound. */
export const ENV_BINDINGS: readonly EnvBinding[] = [
  { env: 'OTEL_HTML_TITLE', path: 'title', parse: 'string' },
  { env: 'OTEL_HTML_FORMAT', path: 'writer.format', parse: 'string' },
];

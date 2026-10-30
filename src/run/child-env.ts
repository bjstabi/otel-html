import { OtelHtmlError } from '../model/errors.js';

export type OtlpProtocol = 'grpc' | 'http/protobuf' | 'http/json';

export interface ChildEnvInput {
  env: Readonly<Record<string, string | undefined>>;
  /** `http://host:port` of the OTLP/HTTP receiver, or null when disabled. */
  http: string | null;
  /** `host:port` of the OTLP/gRPC receiver, or null when disabled. */
  grpc: string | null;
  traceparent: string;
}

const PROTOCOLS: readonly OtlpProtocol[] = ['grpc', 'http/protobuf', 'http/json'];
const DEFAULT_PROTOCOL: OtlpProtocol = 'http/protobuf';

/** The variables `run` adds: the endpoint and protocol keep the user's choice; TRACEPARENT is always ours. */
export const CHILD_ENV: readonly {
  name: string;
  value(input: ChildEnvInput, protocol: OtlpProtocol): string | undefined;
}[] = [
  {
    name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    value: ({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: userEndpoint }, http, grpc }, protocol) =>
      userEndpoint ??
      (protocol === 'grpc' ? (grpc === null ? undefined : `http://${grpc}`) : (http ?? undefined)),
  },
  { name: 'OTEL_EXPORTER_OTLP_PROTOCOL', value: (_input, protocol) => protocol },
  { name: 'TRACEPARENT', value: ({ traceparent }) => traceparent },
];

function protocolOf(env: ChildEnvInput['env']): OtlpProtocol {
  const { OTEL_EXPORTER_OTLP_PROTOCOL: chosen } = env;
  if (chosen === undefined) return DEFAULT_PROTOCOL;
  const found = PROTOCOLS.find((p) => p === chosen);
  if (found === undefined) {
    throw new OtelHtmlError('usage', {
      message: `OTEL_EXPORTER_OTLP_PROTOCOL=${chosen} is not supported by run`,
      hint: `use ${PROTOCOLS.join(', ')}`,
    });
  }
  return found;
}

/** The protocol the child will use, failing with a usage error when it is unknown or its transport is off. */
export function checkedProtocol(
  env: ChildEnvInput['env'],
  enabled: { http: boolean; grpc: boolean },
): OtlpProtocol {
  const protocol = protocolOf(env);
  if (!(protocol === 'grpc' ? enabled.grpc : enabled.http)) {
    const flag = protocol === 'grpc' ? '--grpc' : '--http';
    throw new OtelHtmlError('usage', {
      message: `OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} needs the ${protocol === 'grpc' ? 'gRPC' : 'HTTP'} receiver, which is disabled`,
      hint: `pass ${flag} <port> (or unset OTEL_EXPORTER_OTLP_PROTOCOL for http/protobuf)`,
    });
  }
  return protocol;
}

export function childEnvironment(input: ChildEnvInput): Record<string, string | undefined> {
  const protocol = checkedProtocol(input.env, { http: input.http !== null, grpc: input.grpc !== null });
  return Object.fromEntries(CHILD_ENV.map((v) => [v.name, v.value(input, protocol)]));
}

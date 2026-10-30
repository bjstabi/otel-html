import type { ReceiverConfig } from '../config/schema.js';
import { OtelHtmlError } from '../model/errors.js';
import { listenGrpc } from '../receiver/grpc.js';
import { createHttpHandler, type Listener, listenHttp } from '../receiver/http.js';
import { createReceiver, type ReceiverStats } from '../receiver/receiver.js';
import type { WriterDeps } from '../writer/session.js';
import { configOf, depsOf, type Report, sessionOf } from './report.js';

export interface ListenOverride {
  host?: string;
  port?: number;
}

export interface ReceiverOverrides {
  /** `false` disables the transport; an object enables it with these overrides. */
  http?: ListenOverride | false;
  grpc?: ListenOverride | false;
  maxBodyBytes?: number;
  inflightBudgetBytes?: number;
}

export interface RunningReceiver {
  /** `http://host:port`, or null when disabled. */
  readonly http: string | null;
  /** `host:port`, or null when disabled. */
  readonly grpc: string | null;
  stats(): ReceiverStats;
  /** Stop listening and finish the requests in progress. The report stays open. */
  close(): Promise<void>;
}

interface Endpoint {
  host: string;
  port: number;
}

/** Where a transport listens, or null when it is off: `false` disables, an object enables, else the config decides. */
function endpointOf(
  config: ReceiverConfig,
  transport: { enabled: boolean; port: number },
  override: ListenOverride | false | undefined,
): Endpoint | null {
  if (override === false) return null;
  if (override === undefined && !transport.enabled) return null;
  return { host: override?.host ?? config.host, port: override?.port ?? transport.port };
}

/**
 * Drain the receiver first (it stops accepting receives, so late requests get a retryable busy, and its queue empties), then
 * close every listener whether or not one rejects; rethrow the first rejection.
 */
export async function closeAll(
  listeners: readonly Listener[],
  receiver: { close(): Promise<void> },
): Promise<void> {
  await receiver.close();
  const results = await Promise.allSettled(listeners.map((l) => l.close()));
  for (const r of results) if (r.status === 'rejected') throw r.reason;
}

/** Bind the OTLP transports over `report`. The report stays open after `close()`. */
export async function startReceiver(
  report: Report,
  overrides: ReceiverOverrides = {},
  deps?: Partial<WriterDeps>,
): Promise<RunningReceiver> {
  const config = configOf(report).receiver;
  const httpAt = endpointOf(config, config.http, overrides.http);
  const grpcAt = endpointOf(config, config.grpc, overrides.grpc);
  if (httpAt === null && grpcAt === null) {
    throw new OtelHtmlError('usage', {
      message: 'no receiver transport enabled',
      hint: 'enable http or grpc',
    });
  }
  const full: WriterDeps = { ...depsOf(report), ...deps }; // the report's deps were already validated
  const maxBodyBytes = overrides.maxBodyBytes ?? config.maxBodyBytes;
  const inflightBudgetBytes = overrides.inflightBudgetBytes ?? config.inflightBudgetBytes;
  const receiver = createReceiver(sessionOf(report), { inflightBudgetBytes }, { logger: full.logger });
  const span = full.tracer.startSpan('otel-html.receive');

  const listeners: Listener[] = [];
  let http: Listener | null = null;
  let grpc: Listener | null = null;
  try {
    if (httpAt !== null) {
      http = await listenHttp(
        createHttpHandler(receiver, { maxBodyBytes }, full.logger),
        httpAt.host,
        httpAt.port,
      );
      listeners.push(http);
    }
    if (grpcAt !== null) {
      grpc = await listenGrpc(
        receiver,
        { maxBodyBytes, inflightBudgetBytes },
        full.logger,
        grpcAt.host,
        grpcAt.port,
      );
      listeners.push(grpc);
    }
  } catch (e) {
    await closeAll(listeners, receiver).catch(() => undefined);
    span.recordError(e);
    span.end();
    throw e;
  }

  let closing: Promise<void> | null = null;
  return {
    http: http?.address ?? null,
    grpc: grpc?.address ?? null,
    stats: () => receiver.stats(),
    close() {
      closing ??= (async () => {
        try {
          await closeAll(listeners, receiver);
        } finally {
          const s = receiver.stats();
          span.setAttributes({
            requests: s.requests,
            bytes: s.bytes,
            'accepted.traces': s.accepted.traces,
            'accepted.logs': s.accepted.logs,
            'accepted.metrics': s.accepted.metrics,
            'rejected.traces': s.rejected.traces,
            'rejected.logs': s.rejected.logs,
            'rejected.metrics': s.rejected.metrics,
          });
          span.end();
        }
      })();
      return closing;
    },
  };
}

import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import {
  Metadata,
  type MethodDefinition,
  Server,
  ServerCredentials,
  ServerInterceptingCall,
  type ServerInterceptor,
  ServerListenerBuilder,
  type ServerUnaryCall,
  type ServiceDefinition,
  type sendUnaryData,
  status,
} from '@grpc/grpc-js';
import { RetryInfoSchema } from '../model/gen/google/rpc/error_details_pb.js';
import { StatusSchema } from '../model/gen/google/rpc/status_pb.js';
import type { Logger } from '../writer/ports.js';
import { bindError, bracketed } from './host.js';
import type { Listener } from './http.js';
import type { Receiver } from './receiver.js';
import { SIGNAL_SERVICES, type SignalService } from './signals.js';
import { OUTCOME_STATUS, outcomeOf, RETRY_AFTER_SECONDS, ReceiverRejected, statusMessage } from './status.js';

const SOURCE = 'otlp/grpc';
const FORCE_SHUTDOWN_AFTER_MS = 5_000;
const DETAILS_KEY = 'grpc-status-details-bin';

/** grpc-js refuses (uncounted) above this multiple of `maxBodyBytes`; below it the handler counts the refusal. */
export const GRPC_CEILING_FACTOR = 2;

export interface GrpcTransportOptions {
  maxBodyBytes: number;
  /** The budget each call reserves `maxBodyBytes` from at start; also sizes the per-connection concurrent-call limit (⌈budget ÷ maxBodyBytes⌉) and the HTTP/2 session memory cap. */
  inflightBudgetBytes: number;
  /** How long `close()` waits for `tryShutdown` before force-closing idle or half-open streams. Default 5 s. */
  forceShutdownAfterMs?: number;
}

/** A grpc-js service definition for one OTLP service: raw request bytes in, protobuf-es response out. */
export function serviceDefinition(s: SignalService): ServiceDefinition {
  const definition: Record<string, MethodDefinition<Uint8Array, Message>> = {};
  for (const method of s.service.methods) {
    const def: MethodDefinition<Uint8Array, Message> = {
      path: `/${s.service.typeName}/${method.name}`,
      requestStream: false,
      responseStream: false,
      requestSerialize: (bytes) => Buffer.from(bytes),
      requestDeserialize: (bytes) => bytes,
      responseSerialize: (message) => Buffer.from(toBinary(s.response, message)),
      responseDeserialize: (bytes) => fromBinary(s.response, bytes),
    };
    definition[method.name] = def;
  }
  return definition;
}

function failure(e: unknown, logger: Logger): { code: number; details: string; metadata: Metadata } {
  const outcome = outcomeOf(e);
  const spec = OUTCOME_STATUS[outcome];
  const details = statusMessage(e);
  const code = spec.grpc ?? status.INTERNAL;
  const metadata = new Metadata();
  if (spec.retryable) {
    const retry = create(RetryInfoSchema, { retryDelay: { seconds: BigInt(RETRY_AFTER_SECONDS) } });
    const withRetry = toBinary(
      StatusSchema,
      create(StatusSchema, { code, message: details, details: [anyPack(RetryInfoSchema, retry)] }),
    );
    metadata.set(DETAILS_KEY, Buffer.from(withRetry));
  }
  if (outcome === 'internal') logger.error('grpc request failed', { message: String(e) });
  return { code, details, metadata };
}

/**
 * Reserves `maxBodyBytes` from the receiver's in-flight budget when a call starts (its headers have arrived, its
 * message is not yet buffered) and refuses it as busy when that does not fit, so grpc-js never buffers the body of a
 * refused call. The reservation is held until half-close, not until the message arrives: grpc-js's unary path only
 * stores the message in `onReceiveMessage` and runs the handler synchronously inside `onReceiveHalfClose`, so
 * releasing there and delegating leaves no window in which a buffered body is uncounted (a client that sends a
 * message and never half-closes keeps its reservation). It is also released on cancel (which grpc-js raises
 * after it sends any status itself, such as its too-large refusal) and when a status is sent through the call;
 * `release` is idempotent.
 */
export function admissionInterceptor(
  receiver: Receiver,
  options: GrpcTransportOptions,
  logger: Logger,
): ServerInterceptor {
  return (_method, call) => {
    let reservation: { release(): void } | null = null;
    const release = (): void => {
      reservation?.release();
    };
    return new ServerInterceptingCall(call, {
      start: (next) => {
        const admission = receiver.admit(options.maxBodyBytes);
        if (admission === null) {
          const rejected = new ReceiverRejected(
            'busy',
            'receiver is busy: a new call would exceed the in-flight budget',
          );
          receiver.refused('busy', rejected.message);
          call.sendStatus(failure(rejected, logger));
          return;
        }
        reservation = admission;
        next(
          new ServerListenerBuilder()
            .withOnReceiveHalfClose((forward) => {
              release();
              forward();
            })
            .withOnCancel(release)
            .build(),
        );
      },
      sendStatus: (statusObject, forward) => {
        release();
        forward(statusObject);
      },
    });
  };
}

function handlerFor(s: SignalService, receiver: Receiver, options: GrpcTransportOptions, logger: Logger) {
  return (call: ServerUnaryCall<Uint8Array, Message>, callback: sendUnaryData<Message>): void => {
    if (call.request.length > options.maxBodyBytes) {
      const rejected = new ReceiverRejected(
        'too-large',
        `request of ${call.request.length} bytes exceeds the limit of ${options.maxBodyBytes} bytes`,
      );
      logger.debug('grpc request rejected', { service: s.service.typeName, bytes: call.request.length });
      receiver.refused('too-large', rejected.message);
      callback(failure(rejected, logger));
      return;
    }
    const admission = receiver.admit(call.request.length);
    // Defence in depth: the call's own reservation was just released, so re-admitting the same size cannot fail.
    if (admission === null) {
      const rejected = new ReceiverRejected(
        'busy',
        `receiver is busy: ${call.request.length} bytes would exceed the in-flight budget`,
      );
      receiver.refused('busy', rejected.message);
      callback(failure(rejected, logger));
      return;
    }
    receiver.receive(s.signal, call.request, 'protobuf', SOURCE, admission).then(
      (result) => {
        logger.debug('grpc request', { service: s.service.typeName, bytes: call.request.length });
        callback(null, s.respond(result.accepted, result.rejected, result.errorMessage));
      },
      (e: unknown) => {
        logger.debug('grpc request rejected', { service: s.service.typeName });
        callback(failure(e, logger));
      },
    );
  };
}

/** Binds the three services; `address` is `host:port` as bound. */
export function listenGrpc(
  receiver: Receiver,
  options: GrpcTransportOptions,
  logger: Logger,
  host: string,
  port: number,
): Promise<Listener> {
  const streams = Math.max(1, Math.ceil(options.inflightBudgetBytes / options.maxBodyBytes));
  const server = new Server({
    interceptors: [admissionInterceptor(receiver, options, logger)],
    'grpc.max_receive_message_length': options.maxBodyBytes * GRPC_CEILING_FACTOR,
    'grpc.max_concurrent_streams': streams,
    // Node's HTTP/2 session memory, in MiB: the per-connection ceiling (every stream at the grpc-js message limit), plus 1 MiB of slack for framing.
    'grpc-node.max_session_memory':
      Math.ceil((GRPC_CEILING_FACTOR * options.maxBodyBytes * streams) / 2 ** 20) + 1,
  });
  for (const s of SIGNAL_SERVICES) {
    server.addService(serviceDefinition(s), { Export: handlerFor(s, receiver, options, logger) });
  }
  return new Promise((resolve, reject) => {
    server.bindAsync(`${bracketed(host)}:${port}`, ServerCredentials.createInsecure(), (err, actual) => {
      if (err !== null) {
        server.forceShutdown();
        reject(bindError(err, '--grpc'));
        return;
      }
      resolve({
        address: `${bracketed(host)}:${actual}`,
        close: () =>
          new Promise<void>((done) => {
            const timer = setTimeout(() => {
              server.forceShutdown();
              done();
            }, options.forceShutdownAfterMs ?? FORCE_SHUTDOWN_AFTER_MS);
            server.tryShutdown(() => {
              clearTimeout(timer);
              done();
            });
          }),
      });
    });
  });
}

import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import {
  Metadata,
  type MethodDefinition,
  Server,
  ServerCredentials,
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

function handlerFor(s: SignalService, receiver: Receiver, options: GrpcTransportOptions, logger: Logger) {
  return (call: ServerUnaryCall<Uint8Array, Message>, callback: sendUnaryData<Message>): void => {
    if (call.request.length > options.maxBodyBytes) {
      const rejected = new ReceiverRejected(
        'too-large',
        `request of ${call.request.length} bytes exceeds the limit of ${options.maxBodyBytes} bytes`,
      );
      receiver.refused('too-large', rejected.message);
      callback(failure(rejected, logger));
      return;
    }
    receiver.receive(s.signal, call.request, 'protobuf', SOURCE).then(
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
  const server = new Server({
    'grpc.max_receive_message_length': options.maxBodyBytes * GRPC_CEILING_FACTOR,
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
            }, FORCE_SHUTDOWN_AFTER_MS);
            server.tryShutdown(() => {
              clearTimeout(timer);
              done();
            });
          }),
      });
    });
  });
}

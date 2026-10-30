import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import {
  OUTCOME_STATUS,
  outcomeOf,
  RETRY_AFTER_SECONDS,
  ReceiverRejected,
  statusMessage,
} from '../../src/receiver/status.js';

describe('outcomeOf', () => {
  test('maps typed errors to outcomes', () => {
    expect(outcomeOf(new OtelHtmlError('receiver-busy'))).toBe('busy');
    expect(outcomeOf(new OtelHtmlError('invalid-otlp'))).toBe('invalid');
    expect(outcomeOf(new OtelHtmlError('time-out-of-range'))).toBe('invalid');
    expect(outcomeOf(new OtelHtmlError('unsupported-input'))).toBe('unsupported');
    expect(outcomeOf(new OtelHtmlError('invalid-config'))).toBe('internal');
    expect(outcomeOf(new ReceiverRejected('too-large', 'big'))).toBe('too-large');
    expect(outcomeOf(new ReceiverRejected('not-found', 'nope'))).toBe('not-found');
    expect(outcomeOf(new Error('x'))).toBe('internal');
    expect(outcomeOf('x')).toBe('internal');
  });
});

describe('statusMessage', () => {
  test('is the typed message, never a stack', () => {
    expect(statusMessage(new ReceiverRejected('method', 'use POST'))).toBe('use POST');
    expect(statusMessage(new OtelHtmlError('invalid-otlp', { message: 'bad body' }))).toBe('bad body');
    expect(statusMessage(new Error('secret stack'))).toBe('internal error');
    expect(statusMessage(undefined)).toBe('internal error');
  });
});

describe('OUTCOME_STATUS', () => {
  test('carries the HTTP and gRPC codes', () => {
    expect(OUTCOME_STATUS.busy).toEqual({ http: 503, grpc: 14, retryable: true });
    expect(OUTCOME_STATUS.invalid).toEqual({ http: 400, grpc: 3, retryable: false });
    expect(OUTCOME_STATUS['too-large']).toEqual({ http: 413, grpc: 8, retryable: false });
    expect(OUTCOME_STATUS.unsupported).toEqual({ http: 415, grpc: null, retryable: false });
    expect(OUTCOME_STATUS['not-found']).toEqual({ http: 404, grpc: null, retryable: false });
    expect(OUTCOME_STATUS.method).toEqual({ http: 405, grpc: null, retryable: false });
    expect(OUTCOME_STATUS.internal).toEqual({ http: 500, grpc: 13, retryable: false });
  });

  test('only busy is retryable', () => {
    const retryable = Object.entries(OUTCOME_STATUS).filter(([, s]) => s.retryable);
    expect(retryable.map(([k]) => k)).toEqual(['busy']);
    expect(RETRY_AFTER_SECONDS).toBe(1);
  });
});

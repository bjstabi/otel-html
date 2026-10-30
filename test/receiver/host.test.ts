import { expect, test } from 'vitest';
import { bindError } from '../../src/receiver/host.js';

test('EADDRINUSE names the port flag', () => {
  const e = bindError(
    Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4317'), {
      code: 'EADDRINUSE',
    }),
    '--grpc',
  );
  expect(e.code).toBe('receiver-bind');
  expect(e.message).toContain('EADDRINUSE');
  expect(e.hint).toBe('pass --grpc <port> or --no-grpc');
});

test('EACCES says the port needs privileges', () => {
  expect(bindError(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }), '--http').hint).toBe(
    'ports below 1024 need privileges; pass --http <port>',
  );
});

test('EADDRNOTAVAIL points at --host', () => {
  expect(
    bindError(Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' }), '--http').hint,
  ).toBe('--host must be an address of this machine');
});

test('an unknown code carries no hint', () => {
  expect(bindError(new Error('boom'), '--http').hint).toBeUndefined();
});

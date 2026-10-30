import { OtelHtmlError } from '../model/errors.js';

/** An IPv6 literal wrapped in brackets for use in an address; anything else unchanged. */
export function bracketed(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

type BindFlag = '--http' | '--grpc';

const ADDRESS_HINT = (): string => '--host must be an address of this machine';

const HINT_BY_CODE: Readonly<Record<string, (flag: BindFlag) => string>> = {
  EADDRINUSE: (flag) => `pass ${flag} <port> or --no-${flag.slice(2)}`,
  EACCES: (flag) => `ports below 1024 need privileges; pass ${flag} <port>`,
  EADDRNOTAVAIL: ADDRESS_HINT,
  ENOTFOUND: ADDRESS_HINT,
};

/** A failed bind as a typed error: the system's message is kept, and the hint is chosen by errno. */
export function bindError(e: unknown, flag: BindFlag): OtelHtmlError {
  const message = e instanceof Error ? e.message : String(e);
  const code: unknown = typeof e === 'object' && e !== null ? Reflect.get(e, 'code') : undefined;
  // grpc-js reports a failed bind as a plain Error whose message names the errno, so fall back to the message.
  const errno = typeof code === 'string' ? code : Object.keys(HINT_BY_CODE).find((k) => message.includes(k));
  const hint = errno === undefined ? undefined : HINT_BY_CODE[errno]?.(flag);
  return new OtelHtmlError('receiver-bind', hint === undefined ? { message } : { message, hint });
}

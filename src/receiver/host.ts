import { OtelHtmlError } from '../model/errors.js';

/** An IPv6 literal wrapped in brackets for use in an address; anything else unchanged. */
export function bracketed(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** A failed bind as a typed error: the system's message is kept, and the hint names the flag that moves the port. */
export function bindError(e: unknown, flag: '--http' | '--grpc'): OtelHtmlError {
  const message = e instanceof Error ? e.message : String(e);
  return new OtelHtmlError('receiver-busy', {
    message,
    hint: `pass ${flag} <port> or --no-${flag.slice(2)}`,
  });
}

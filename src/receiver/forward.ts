import { OtelHtmlError } from '../model/errors.js';
import type { OtlpSignal } from '../model/otlp-json.js';
import type { Logger } from '../writer/ports.js';
import type { BodyEncoding } from './receiver.js';

type Fetch = typeof fetch;

const MAX_QUEUED = 64;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 5_000;

export interface ForwarderOptions {
  /** The collector's base URL; the signal path is appended. */
  endpoint: string;
  headers: Record<string, string>;
  /** Requests held, the one being sent included (64). */
  maxQueued?: number;
  /** Body bytes held, the one being sent included (64 MiB). */
  maxQueuedBytes?: number;
  /** Per request, no retry (10 s). */
  timeoutMs?: number;
  fetchFn?: Fetch;
  logger: Logger;
}

export interface Forwarder {
  /** Queue an accepted request's body; never throws. A full queue drops it and counts. */
  enqueue(signal: OtlpSignal, body: Uint8Array, encoding: BodyEncoding): void;
  stats(): { forwarded: number; dropped: number; failed: number };
  /** Wait up to 5 s for the queue; what is still unsent or stuck then is counted and abandoned. Idempotent. */
  close(): Promise<void>;
}

export const SIGNAL_PATH: Record<OtlpSignal, string> = {
  traces: '/v1/traces',
  logs: '/v1/logs',
  metrics: '/v1/metrics',
};

const CONTENT_TYPE: Record<BodyEncoding, string> = {
  json: 'application/json',
  protobuf: 'application/x-protobuf',
};

/** `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`, values URL-decoded) as headers; a malformed pair is a usage error. */
export function parseOtlpHeaders(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (text === undefined || text.trim() === '') return headers;
  for (const pair of text.split(',')) {
    const at = pair.indexOf('=');
    const name = at < 0 ? '' : pair.slice(0, at).trim();
    if (name === '') {
      throw new OtelHtmlError('usage', {
        message: `OTEL_EXPORTER_OTLP_HEADERS: "${pair.trim()}" is not key=value`,
        hint: 'use key=value,key2=value2',
      });
    }
    try {
      headers[name] = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      throw new OtelHtmlError('usage', {
        message: `OTEL_EXPORTER_OTLP_HEADERS: the value of ${name} is not URL-encoded text`,
        hint: 'use key=value,key2=value2',
      });
    }
  }
  return headers;
}

interface Item {
  signal: OtlpSignal;
  body: Uint8Array;
  encoding: BodyEncoding;
}

export function createForwarder(o: ForwarderOptions): Forwarder {
  const fetchFn = o.fetchFn ?? fetch;
  const maxQueued = o.maxQueued ?? MAX_QUEUED;
  const maxBytes = o.maxQueuedBytes ?? MAX_QUEUED_BYTES;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const headers = Object.fromEntries(
    Object.entries(o.headers).filter(([k]) => k.toLowerCase() !== 'content-type'),
  );
  const base = o.endpoint.replace(/\/+$/, '');
  const totals = { forwarded: 0, dropped: 0, failed: 0 };
  const pending: Item[] = [];
  let held = 0;
  let heldBytes = 0;
  let sending: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let warned = false;
  const abandon = new AbortController();

  function fail(reason: string): void {
    totals.failed++;
    if (warned) return;
    warned = true;
    o.logger.warn('forwarding to the collector failed; further failures are counted, not logged', { reason });
  }

  async function send(item: Item): Promise<void> {
    const ctl = new AbortController();
    const abort = (): void => ctl.abort(new Error('aborted'));
    const timer = setTimeout(() => ctl.abort(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
    abandon.signal.addEventListener('abort', abort);
    try {
      const stopped = new Promise<never>((_, reject) => {
        ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason));
      });
      stopped.catch(() => undefined);
      const res = await Promise.race([
        fetchFn(`${base}${SIGNAL_PATH[item.signal]}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': CONTENT_TYPE[item.encoding] },
          body: new Uint8Array(item.body), // a copy typed as an ArrayBuffer view, which fetch accepts
          signal: ctl.signal,
        }),
        stopped,
      ]);
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) totals.forwarded++;
      else fail(`the collector answered ${res.status}`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      abandon.signal.removeEventListener('abort', abort);
    }
  }

  async function drain(): Promise<void> {
    for (let item = pending.shift(); item !== undefined; item = pending.shift()) {
      await send(item);
      held--;
      heldBytes -= item.body.length;
    }
    sending = null;
  }

  return {
    enqueue(signal, body, encoding) {
      if (closing !== null || held >= maxQueued || heldBytes + body.length > maxBytes) {
        totals.dropped++;
        return;
      }
      held++;
      heldBytes += body.length;
      pending.push({ signal, body, encoding });
      sending ??= drain();
    },
    stats: () => ({ ...totals }),
    close() {
      closing ??= (async () => {
        let timer: NodeJS.Timeout | undefined;
        const gaveUp = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_WAIT_MS);
        });
        const drained = sending ?? Promise.resolve();
        await Promise.race([drained, gaveUp]);
        clearTimeout(timer);
        totals.dropped += pending.length;
        pending.length = 0;
        abandon.abort();
        await drained;
      })();
      return closing;
    },
  };
}

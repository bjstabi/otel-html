import type { Page } from '@playwright/test';

/**
 * Runs `sql` on a new connection of the page's DuckDB worker, by feeding the worker the same messages the engine's
 * main-thread half sends (the engine is not reachable from the page). Resolves with the reply's type and, for a
 * failure, its message. Only for tests: the page must have started its engine (the last worker is the engine's).
 */
export async function runWorkerSql(page: Page, sql: string): Promise<{ type: string; message: string }> {
  const worker = page.workers().at(-1);
  if (worker === undefined) throw new Error('the page has no worker');
  return worker.evaluate(async (statement) => {
    const g = globalThis as unknown as {
      postMessage: (m: unknown, t?: unknown) => void;
      onmessage: (e: { data: unknown }) => void;
    };
    const original = g.postMessage.bind(g);
    let resolveReply: (m: { type: string; data?: { message?: string } | unknown }) => void = () => undefined;
    g.postMessage = (m, t) => {
      const reply = m as { requestId?: number };
      if (reply !== null && typeof reply === 'object' && (reply.requestId ?? 0) >= 900000) {
        resolveReply(m as never);
        return;
      }
      original(m, t);
    };
    let id = 900000;
    const send = (type: string, data: unknown) => {
      const reply = new Promise<{ type: string; data?: unknown }>((r) => {
        resolveReply = r as never;
      });
      g.onmessage({ data: { messageId: id++, type, data } });
      return reply;
    };
    try {
      const connection = await send('CONNECT', null);
      const result = await send('RUN_QUERY', [connection.data, statement]);
      const data = result.data as { message?: string } | undefined;
      return { type: result.type, message: String(data?.message ?? '') };
    } finally {
      g.postMessage = original;
    }
  }, sql);
}

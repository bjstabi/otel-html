/** A file this size or smaller is fetched whole and swapped in as a buffer; larger ones keep their range reads. */
export const SMALL_FILE_BYTES = 262_144;

const DEFAULT_CONCURRENCY = 6;

export interface SmallFiles {
  /**
   * Fetches the small files among `paths` whole and swaps each in as a buffer. Resolves even when a fetch or swap
   * failed (the file stays registered by URL and answers by range reads, and the next prepare tries again). An
   * aborted signal rejects with `DOMException('AbortError')` and leaves the files retryable; other callers waiting on
   * the same file are not affected.
   */
  prepare(paths: readonly string[], signal?: AbortSignal): Promise<void>;
  /** Drops what is known about `paths`: the next prepare fetches and swaps them again. */
  forget(paths: readonly string[]): void;
}

export interface SmallFilesDeps {
  /** The manifest's size of `path`, or undefined when the manifest does not list it. */
  bytesOf(path: string): number | undefined;
  /** One GET without a Range header. */
  fetchWhole(path: string): Promise<Uint8Array>;
  /** Replaces the URL registration of `path` by a buffer. */
  swap(path: string, bytes: Uint8Array): Promise<void>;
  threshold?: number;
  concurrency?: number;
}

interface Entry {
  /** Settles, never rejects, once the file is swapped or its attempt failed. */
  settled: Promise<void>;
  swapped: boolean;
}

function abortError(): DOMException {
  return new DOMException('The prepare was aborted', 'AbortError');
}

export function smallFiles(deps: SmallFilesDeps): SmallFiles {
  const threshold = deps.threshold ?? SMALL_FILE_BYTES;
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const entries = new Map<string, Entry>();
  let running = 0;
  const waiting: (() => void)[] = [];

  const acquire = async (): Promise<void> => {
    if (running < concurrency) {
      running += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };

  const start = (path: string): Entry => {
    const entry: Entry = { swapped: false, settled: Promise.resolve() };
    entry.settled = (async () => {
      await acquire();
      try {
        const bytes = await deps.fetchWhole(path);
        // forgotten while in flight: the file may be gone or replaced, so swap nothing
        if (entries.get(path) !== entry) return;
        await deps.swap(path, bytes);
        entry.swapped = true;
      } catch {
        // stays registered by URL; the next prepare retries
      } finally {
        release();
        if (!entry.swapped && entries.get(path) === entry) entries.delete(path);
      }
    })();
    return entry;
  };

  return {
    async prepare(paths, signal) {
      if (signal?.aborted) throw abortError();
      const waits: Promise<void>[] = [];
      for (const path of new Set(paths)) {
        const size = deps.bytesOf(path);
        if (size === undefined || size > threshold) continue;
        let entry = entries.get(path);
        if (entry?.swapped) continue;
        if (!entry) {
          entry = start(path);
          entries.set(path, entry);
        }
        waits.push(entry.settled);
      }
      const all = Promise.all(waits).then(() => undefined);
      if (!signal) return await all;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await Promise.race([all, aborted]);
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        aborted.catch(() => undefined);
      }
    },
    forget(paths) {
      for (const path of paths) entries.delete(path);
    },
  };
}

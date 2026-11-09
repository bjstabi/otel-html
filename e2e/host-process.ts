import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const START_TIMEOUT_MS = 60_000; // above the host's own 30 s open deadline, so its error wins
const KILL_GRACE_MS = 5_000;
const SERVING = /serving .* at (http:\/\/127\.0\.0\.1:\d+)\//;

/** Waits for `child` to exit; true when it did within `ms`. */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Spawns `node dist/cli/main.js host <report> --port 0 [...args]` and resolves the printed `http://127.0.0.1:<port>`
 * once the serving line appears (60 s). `close()` sends SIGTERM and, after a bound, SIGKILL. The page must be opened
 * at exactly this URL: the host refuses a foreign Host header.
 */
export async function startHost(
  report: string,
  args: readonly string[] = [],
): Promise<{ url: string; stderr(): string; close(): Promise<void> }> {
  // The test's own OTLP endpoint must not leak into the host: it would export its own spans there.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('OTEL_EXPORTER_OTLP_')),
  );
  const child = spawn(process.execPath, [MAIN, 'host', report, '--port', '0', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    out += d;
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    err += d;
  });
  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await exited(child, KILL_GRACE_MS)) return;
    child.kill('SIGKILL');
    await exited(child, KILL_GRACE_MS);
  };
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `host did not print its serving line in ${START_TIMEOUT_MS} ms\nstdout: ${out}\nstderr: ${err}`,
          ),
        ),
      START_TIMEOUT_MS,
    );
    const check = (): void => {
      const m = SERVING.exec(out);
      if (m?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(m[1]);
    };
    child.stdout.on('data', check);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`host exited (${code ?? signal}) before serving\nstdout: ${out}\nstderr: ${err}`));
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  }).catch(async (e: unknown) => {
    await close();
    throw e;
  });
  return { url, stderr: () => err, close };
}

import { OtelHtmlError } from '../../src/model/errors.js';

/** How long one step of the measurement may take before it counts as hung. */
export const STEP_TIMEOUT_MS = 60_000;

/** `work`, or an error naming `what` once `ms` have passed (the work itself is not cancelled). */
export async function bounded<T>(work: Promise<T>, what: string, ms = STEP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OtelHtmlError('usage', { message: `${what} did not finish in ${ms / 1000} s` })),
      ms,
    );
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits for a folder (`lock`) another worker holds: sleeps 100 ms, and fails naming `what` after `ms`. */
export async function waitTurn(since: number, what: string, ms = STEP_TIMEOUT_MS): Promise<void> {
  if (performance.now() - since > ms)
    throw new OtelHtmlError('usage', { message: `${what}: waited ${ms / 1000} s for another worker` });
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

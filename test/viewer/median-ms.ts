/** One untimed warm-up call (JIT), then the median wall time of `samples` timed calls; returns the last result. */
export function medianMs<T>(run: () => T, samples = 7): { result: T; ms: number } {
  let result = run();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    result = run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { result, ms: times[Math.floor(times.length / 2)] ?? Number.POSITIVE_INFINITY };
}

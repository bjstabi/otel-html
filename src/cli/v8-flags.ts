// Under Node, V8 sizes its heap at several times the live data when allocation is steady. A receiver (`serve`, `run`)
// sets `--optimize-for-size --heap-growing-percent=40` before it runs: the first keeps memory low, the second keeps
// full-GC pauses short so a sender's batch queue does not overflow (#73 measured 473 MB when set at start-up against
// 524 MB when set mid-run). The library sets no flags.
export const RECEIVER_V8_FLAGS = '--optimize-for-size --heap-growing-percent=40';

export function v8FlagsFor(
  argv: readonly string[],
  versions: Readonly<Partial<Record<string, string>>>,
): string | null {
  const command = argv.find((a) => !a.startsWith('-'));
  if ((command === 'serve' || command === 'run') && !('bun' in versions)) return RECEIVER_V8_FLAGS;
  return null;
}

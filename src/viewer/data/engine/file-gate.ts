/**
 * Orders file changes against statements. A statement `wait()`s before it is posted to the engine's worker; a file
 * change runs inside `hold()`, which blocks statements posted after it began until it finishes. Statements already
 * posted run first (the worker takes messages in order), so none runs between the two messages of a swap.
 */
export interface FileGate {
  wait(): Promise<void>;
  hold<T>(change: () => Promise<T>): Promise<T>;
}

export function createFileGate(): FileGate {
  let tail: Promise<void> = Promise.resolve();
  let holding: Promise<void> | null = null;
  return {
    async wait() {
      while (holding !== null) {
        const current = holding;
        await current;
        if (holding === current) holding = null;
      }
    },
    hold(change) {
      const run = tail.then(change);
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      tail = settled;
      holding = settled;
      return run;
    },
  };
}

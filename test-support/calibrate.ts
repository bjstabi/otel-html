import { cpus } from 'node:os';

/**
 * A fixed CPU workload shaped like the code under test: build OTLP-like records, stringify and parse them, intern
 * their attributes in a Map and sort them. Deterministic, single-threaded and allocation-heavy, so its time tracks
 * how fast a runner executes the viewer and the writer.
 */
function workload(): number {
  const records = Array.from({ length: 40_000 }, (_, i) => ({
    traceId: (i * 2654435761).toString(16).padStart(32, '0'),
    name: `op-${i % 23}`,
    start: 1_700_000_000_000 + i * 37,
    attributes: [
      { key: 'http.route', value: { stringValue: `/r/${i % 97}` } },
      { key: 'service.name', value: { stringValue: `svc-${i % 13}` } },
    ],
  }));
  const parsed = JSON.parse(JSON.stringify(records)) as typeof records;
  const interned = new Map<string, number>();
  for (const r of parsed) {
    for (const a of r.attributes) {
      const k = `${a.key}=${a.value.stringValue}`;
      interned.set(k, (interned.get(k) ?? 0) + 1);
    }
  }
  parsed.sort((a, b) => (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : a.start - b.start));
  return interned.size + (parsed[0]?.start ?? 0);
}

/** The workload's median time in ms over `runs` runs, after one warm-up run. */
export function calibrationMs(runs = 7): number {
  workload();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    workload();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}

/** The CPU model this run measured on, for the perf log. */
export function cpuModel(): string {
  return cpus()[0]?.model.trim() ?? 'unknown CPU';
}

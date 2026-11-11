import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { shardOf, type Weights } from './shard.ts';
import table from './shard-weights.json' with { type: 'json' };

/** `moduleId` relative to the root, with forward slashes: the key of a unit test file in `shard-weights.json`. */
function relativeKey(root: string, moduleId: string): string {
  const slash = (s: string) => s.replaceAll('\\', '/');
  const r = slash(root).replace(/\/$/, '');
  const id = slash(moduleId);
  return id.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? id.slice(r.length + 1) : id;
}

const { OTEL_HTML_PERF_PASS } = process.env;

/**
 * Vitest's `--shard=i/n` split by recorded duration instead of by file hash (the hash split left Windows' unit shards
 * at 182 s and 130 s). The perf pass (`OTEL_HTML_PERF_PASS=1`) has its own table. `sort()` stays vitest's. Every
 * shard computes the same split from the same file list and the committed table, so no CI state is involved.
 */
export class WeightedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const weights: Weights = OTEL_HTML_PERF_PASS === '1' ? table['unit-perf'] : table.unit;
    const byKey = new Map<string, TestSpecification[]>();
    for (const spec of files) {
      const key = relativeKey(root, spec.moduleId);
      byKey.set(key, [...(byKey.get(key) ?? []), spec]);
    }
    const mine = shardOf([...byKey.keys()], weights, shard.index, shard.count);
    return mine.flatMap((key) => byKey.get(key) ?? []);
  }
}

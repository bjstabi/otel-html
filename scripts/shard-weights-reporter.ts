import { writeFileSync } from 'node:fs';
import type { Reporter, TestModule } from 'vitest/node';

/**
 * A vitest reporter for `scripts/shard-weights.ts`: per test file, the seconds a worker spends on it, written to the
 * file named by OTEL_HTML_SHARD_WEIGHTS_OUT. The JSON reporter's file time only spans the first test's start to the
 * last test's end; a file's cost on a shard also includes starting the environment, the harness, the setup files and
 * importing the module (jsdom and the viewer's imports are most of the small files' time). So the weight is the sum of
 * the diagnostic's environment, prepare, setup, collect and test durations.
 */
export default class ShardWeightsReporter implements Reporter {
  private readonly seconds = new Map<string, number>();

  onTestModuleEnd(module: TestModule): void {
    const d = module.diagnostic();
    const ms =
      d.environmentSetupDuration + d.prepareDuration + d.setupDuration + d.collectDuration + d.duration;
    this.seconds.set(module.relativeModuleId.replaceAll('\\', '/'), ms / 1000);
  }

  onTestRunEnd(): void {
    const { OTEL_HTML_SHARD_WEIGHTS_OUT: out } = process.env;
    if (out) writeFileSync(out, JSON.stringify(Object.fromEntries(this.seconds)));
  }
}

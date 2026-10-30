import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The factor `@perf` budgets are multiplied by, provided by `perf-global-setup.ts`. */
    perfFactor: number;
  }
}

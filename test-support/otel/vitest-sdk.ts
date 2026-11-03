import { startTestSdk } from './sdk.ts';

/** Vitest's `experimental.openTelemetry.sdkPath`: starts the SDK in each worker; vitest calls `shutdown` at the end. */
const sdk: { shutdown(): Promise<void> } = startTestSdk(process.env, 'vitest') ?? {
  shutdown: () => Promise.resolve(),
};
export default sdk;

import { detectResources, envDetector, hostDetector, processDetector } from '@opentelemetry/resources';
import type { KeyValue } from '../model/gen/opentelemetry/proto/common/v1/common_pb.js';
import { attributesToKeyValues } from '../model/sdk-spans.js';
import { executableName } from './root-span.js';

/** The run's resource: env, host and process detectors, with `service.name` defaulting to the command's name. */
export async function detectRunResource(command: readonly string[]): Promise<KeyValue[]> {
  const resource = detectResources({ detectors: [envDetector, hostDetector, processDetector] });
  await resource.waitForAsyncAttributes?.();
  const attributes = { ...resource.attributes };
  if (attributes['service.name'] === undefined) {
    attributes['service.name'] = executableName(command[0] ?? '');
  }
  return attributesToKeyValues(attributes);
}

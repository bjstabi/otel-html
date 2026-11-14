import { type AnyManifest, isPartitioned, type ManifestV4 } from '../../format/manifest.js';
import { oldFormatMessage } from '../../format/version.js';
import { OtelHtmlError } from '../../model/errors.js';

/** The D12 gate: the viewer reads format 5; a report of format 1 to 4 is refused (1 to 3 are converted by `merge`). */
export function requireFormat4(manifest: AnyManifest): ManifestV4 {
  if (isPartitioned(manifest)) return manifest;
  throw new OtelHtmlError('invalid-report', {
    message: oldFormatMessage(manifest.formatVersion),
  });
}

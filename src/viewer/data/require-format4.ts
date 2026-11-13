import { type AnyManifest, isPartitioned, type ManifestV4 } from '../../format/manifest.js';
import { oldFormatMessage } from '../../format/version.js';
import { OtelHtmlError } from '../../model/errors.js';

/** The D12 gate: the viewer reads the partition formats (4 and 5); a chunk report (1 to 3) is converted by `merge`. */
export function requireFormat4(manifest: AnyManifest): ManifestV4 {
  if (isPartitioned(manifest)) return manifest;
  throw new OtelHtmlError('invalid-report', {
    message: oldFormatMessage(manifest.formatVersion),
  });
}

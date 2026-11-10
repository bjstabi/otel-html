import { type AnyManifest, isV4, type ManifestV4 } from '../../format/manifest.js';
import { oldFormatMessage } from '../../format/version.js';
import { OtelHtmlError } from '../../model/errors.js';

/** The D12 gate: the viewer reads format 4 only. */
export function requireFormat4(manifest: AnyManifest): ManifestV4 {
  if (isV4(manifest)) return manifest;
  throw new OtelHtmlError('invalid-report', {
    message: oldFormatMessage(manifest.formatVersion),
  });
}

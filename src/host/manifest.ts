import { reviveDataJson, unwrapDataFile } from '../format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../format/manifest.js';
import { MANIFEST_KEY, MANIFEST_PATH } from '../format/paths.js';
import { oldFormatMessage } from '../format/version.js';
import { OtelHtmlError } from '../model/errors.js';
import type { FileSystem } from '../writer/ports.js';

export interface HostManifest {
  manifest: ManifestV4;
  /** The text of `data/manifest.js` as read, served as is (D41). */
  script: string;
  /** The listed files' bytes, summed. */
  partitionBytes: number;
}

/**
 * Reads the report's manifest once at start (D41). A missing `data/manifest.js` is `usage`; a format 1 to 3
 * report is `invalid-report` with the `merge` hint (D12).
 */
export async function readHostManifest(
  fs: Pick<FileSystem, 'exists' | 'readText'>,
  report: string,
): Promise<HostManifest> {
  const path = `${report.replace(/[\\/]+$/, '')}/${MANIFEST_PATH}`;
  if (!(await fs.exists(path))) {
    throw new OtelHtmlError('usage', { message: `no report found at ${report} (missing ${MANIFEST_PATH})` });
  }
  const script = await fs.readText(path);
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(script, MANIFEST_KEY)));
  if (!isV4(manifest)) {
    throw new OtelHtmlError('invalid-report', {
      message: oldFormatMessage(manifest.formatVersion),
      hint: `otel-html merge ${report} --out <new>`,
    });
  }
  let partitionBytes = 0;
  for (const p of manifest.partitions) for (const f of Object.values(p.files)) partitionBytes += f.bytes;
  return { manifest, script, partitionBytes };
}

import { parse } from 'yaml';
import { OtelHtmlError } from '../model/errors.js';
import type { FileSystem } from '../writer/ports.js';

export async function loadConfigFile(fs: FileSystem, path: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readText(path);
  } catch (e) {
    throw new OtelHtmlError('invalid-config', {
      path,
      expected: 'readable config file',
      actual: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    // YAML 1.2 is a superset of JSON, so one parser handles both.
    return parse(text) as unknown;
  } catch (e) {
    throw new OtelHtmlError('invalid-config', {
      path,
      expected: 'valid YAML or JSON',
      actual: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function findConfigPath(
  fs: FileSystem,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  const { OTEL_HTML_CONFIG: fromEnv } = env;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const candidate = `${cwd.replace(/\/$/, '')}/otel-html.yaml`;
  return (await fs.exists(candidate)) ? candidate : null;
}

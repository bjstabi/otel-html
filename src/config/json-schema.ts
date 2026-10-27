import { z } from 'zod';
import { ConfigSchema } from './schema.js';

/** JSON Schema for editor autocomplete of otel-html.yaml (input shape: defaults are optional). */
export function writeJsonSchema(): string {
  const schema = z.toJSONSchema(ConfigSchema, { io: 'input', target: 'draft-2020-12' });
  return `${JSON.stringify(schema, null, 2)}\n`;
}

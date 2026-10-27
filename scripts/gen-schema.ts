import { writeFileSync } from 'node:fs';
import { writeJsonSchema } from '../src/config/json-schema.js';

writeFileSync(new URL('../schema/otel-html.schema.json', import.meta.url), writeJsonSchema());

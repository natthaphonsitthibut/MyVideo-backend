// Prints openapi.json to stdout: `pnpm gen:openapi` writes it to backend/openapi.json.
import { buildOpenApi } from '../openapi.js';

process.stdout.write(`${JSON.stringify(buildOpenApi(), null, 2)}\n`);

// Writes the OpenAPI document to server/openapi.json as a static repo artifact.
// Single source of truth is src/openapi.ts. Run: npm run openapi:dump
import { writeFile } from "node:fs/promises";
import { openapiSpec } from "../dist/openapi.js";

await writeFile(new URL("../openapi.json", import.meta.url), JSON.stringify(openapiSpec, null, 2) + "\n");
console.error("Wrote openapi.json");

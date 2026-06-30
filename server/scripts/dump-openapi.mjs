// Writes the OpenAPI document to server/openapi.json as a static repo artifact.
// Single source of truth is src/openapi.ts. Run: npm run openapi:dump
//
// Tries to populate the live-enumerated filters (status, municipality) from the
// registry so the committed artifact matches what /openapi.json serves; falls
// back to the base spec (free-form string params) if the registry is unreachable.
import { writeFile } from "node:fs/promises";
import { buildOpenApiSpec, openapiSpec } from "../dist/openapi.js";
import { SijilatClient } from "../dist/sijilat.js";

let spec = openapiSpec;
try {
  const lt = await new SijilatClient().lookups();
  spec = buildOpenApiSpec({ status: lt.status, municipalities: lt.municipalities });
  console.error(`Injected live options: ${lt.status.length} statuses, ${lt.municipalities.length} municipalities`);
} catch (err) {
  console.error(`Live lookups unavailable (${err?.message ?? err}); writing base spec without enumerated options`);
}

await writeFile(new URL("../openapi.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");
console.error("Wrote openapi.json");

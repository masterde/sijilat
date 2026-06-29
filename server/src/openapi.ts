// OpenAPI 3.1 description of the Sijilat API. Single source of truth: served at
// GET /openapi.json and rendered at GET /docs. `scripts/dump-openapi.mjs` writes
// it to openapi.json in the repo as a static artifact.

const company = {
  type: "object",
  properties: {
    cr_number: { type: "string", example: "21" },
    branch: { type: "string", example: "10" },
    name_en: { type: "string", example: "INTERMART GENERAL TRADING W.L.L" },
    name_ar: { type: "string" },
    company_type: { type: "string", example: "With Limited Liability Company" },
    status: { type: "string", example: "ACTIVE" },
    registered_on: { type: "string", example: "05/09/2007" },
    expires_on: { type: "string", example: "05/09/2027" },
    activities: { type: "array", items: { type: "string" } },
    sector: { type: "string" },
  },
} as const;

const codeName = {
  type: "object",
  properties: {
    code: { type: "string" },
    name: { type: "string" },
    flag: { type: "string" },
  },
} as const;

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const;

const filterParams = [
  ["name_en", "Company name in English (partial, case-insensitive)", "trading"],
  ["name_ar", "Company name in Arabic (partial). Pair with lang=ar.", "تجارة"],
  ["cr", "Exact Commercial Registration number", "21"],
  ["status", "Status name(s) or code(s); names resolve case-insensitively (e.g. ACTIVE). Comma-separate for multiple.", "ACTIVE"],
  ["type", "Company type name(s) or code(s)", "With Limited Liability Company"],
  ["nationality", "Company nationality name(s)/flag (e.g. BAHRAINI, GCC) or code(s)", "BAHRAINI"],
  ["sector", "Top-level business sector by name or code (see /lookups/sector)", "Manufacturing"],
  ["activity", "Granular ISIC4 activity by name or code; names resolve via /lookups/activity (see that endpoint)", "restaurant"],
  ["municipality", "Municipality by name or code (see /lookups/municipality)", "Manama"],
  ["partner", "Partner/shareholder English name", ""],
  ["partner_ar", "Partner/shareholder Arabic name", ""],
  ["partner_nat", "Partner nationality name/code", ""],
  ["partner_cr", "Partner's CR number", ""],
  ["reg_from", "Registered on or after (DD/MM/YYYY)", ""],
  ["reg_to", "Registered on or before (DD/MM/YYYY)", ""],
  ["road", "Address: road number", ""],
  ["flat", "Address: flat number", ""],
  ["block", "Address: block number", ""],
  ["building", "Address: building number", ""],
  ["passport", "Partner passport number", ""],
].map(([name, description, example]) => ({
  name,
  in: "query",
  description,
  required: false,
  schema: { type: "string", ...(example ? { example } : {}) },
}));

const pagingParams = [
  { name: "page", in: "query", description: "Page number (default 1).", schema: { type: "integer", default: 1, minimum: 1 } },
  { name: "per_page", in: "query", description: "Results per page (default 25, max 200). Alias: limit.", schema: { type: "integer", default: 25, minimum: 1, maximum: 200 } },
  { name: "all", in: "query", description: "Set to 1 to page through every match (bounded by max_scan_pages).", schema: { type: "string", enum: ["0", "1"] } },
  { name: "max_scan_pages", in: "query", description: "Max pages to fetch when all=1 (default 20).", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
  { name: "fields", in: "query", description: "Comma-separated result fields to return (e.g. cr_number,name_en,status).", schema: { type: "string" } },
  { name: "lang", in: "query", description: "Set to 'ar' to match Arabic-culture names.", schema: { type: "string", enum: ["en", "ar"] } },
];

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Sijilat API",
    version: "0.2.0",
    description:
      "Query the Kingdom of Bahrain's Sijilat commercial registry. Filters accept friendly names (case-insensitive), resolved to the registry's internal codes automatically. No registry account or key is required.",
  },
  servers: [
    { url: "https://sijilat-api.vercel.app", description: "Production" },
    { url: "http://localhost:3000", description: "Local" },
  ],
  paths: {
    "/health": {
      get: {
        summary: "Liveness + registry reachability",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, registry: { type: "string" }, status_codes: { type: "integer" } } } } } },
          "503": { description: "Registry unreachable", content: { "application/json": { schema: errorSchema } } },
        },
      },
    },
    "/search": {
      get: {
        summary: "Search commercial registrations",
        description:
          "At least one filter is required. Name/sector/activity/status/type/nationality/municipality accept friendly names (case-insensitive, comma-separated for multiple) and resolve to codes. Default response is one page; use page/per_page to paginate or all=1 to pull everything.",
        parameters: [...filterParams, ...pagingParams],
        responses: {
          "200": {
            description: "Matching companies",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    source: { type: "string", example: "live" },
                    total_matches: { type: "integer", example: 20778 },
                    page: { type: "integer" },
                    per_page: { type: "integer" },
                    returned: { type: "integer" },
                    has_more: { type: "boolean" },
                    results: { type: "array", items: company },
                  },
                },
              },
            },
          },
          "400": { description: "No filter supplied", content: { "application/json": { schema: errorSchema } } },
          "429": { description: "Rate limited", content: { "application/json": { schema: errorSchema } } },
          "502": { description: "Upstream registry error", content: { "application/json": { schema: errorSchema } } },
        },
      },
    },
    "/company/{cr}": {
      get: {
        summary: "Full company profile",
        description: "Returns capital, shareholders, board, signatories, address, activities, amendment history, and branches. Use raw=1 for the unmodified upstream payload.",
        parameters: [
          { name: "cr", in: "path", required: true, description: "Commercial Registration number", schema: { type: "string", example: "106966" } },
          { name: "branch", in: "query", description: "Branch number (head office = 1)", schema: { type: "string", default: "1" } },
          { name: "raw", in: "query", description: "Set to 1 to return the complete unmodified upstream payload.", schema: { type: "string", enum: ["0", "1"] } },
        ],
        responses: {
          "200": { description: "Company profile", content: { "application/json": { schema: { type: "object" } } } },
          "429": { description: "Rate limited", content: { "application/json": { schema: errorSchema } } },
          "502": { description: "Upstream registry error", content: { "application/json": { schema: errorSchema } } },
        },
      },
    },
    "/lookups": {
      get: {
        summary: "All filter code tables",
        responses: { "200": { description: "Code tables", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/lookups/activity": {
      get: {
        summary: "Search business activities (ISIC4) by name",
        description: "Returns ISIC4 {code,name} matches from the bundled activity table. Use the code with /search?activity=<code>; /search?activity=<name> also resolves automatically. Raw ISIC4 codes always work even when not in the table.",
        parameters: [
          { name: "q", in: "query", description: "Activity name search text (e.g. restaurant, warehouse).", schema: { type: "string", example: "restaurant" } },
          { name: "limit", in: "query", description: "Max matches (default 50).", schema: { type: "integer", default: 50 } },
        ],
        responses: { "200": { description: "Matching activities", content: { "application/json": { schema: { type: "object", properties: { table: { type: "string" }, query: { type: "string" }, count: { type: "integer" }, values: { type: "array", items: codeName } } } } } } },
      },
    },
    "/lookups/{table}": {
      get: {
        summary: "One filter code table",
        parameters: [{ name: "table", in: "path", required: true, schema: { type: "string", enum: ["status", "type", "nationality", "sector", "municipality"] } }],
        responses: {
          "200": { description: "Code table", content: { "application/json": { schema: { type: "object", properties: { table: { type: "string" }, count: { type: "integer" }, values: { type: "array", items: codeName } } } } } },
          "400": { description: "Unknown table", content: { "application/json": { schema: errorSchema } } },
        },
      },
    },
  },
  components: { schemas: { Company: company, CodeName: codeName, Error: errorSchema } },
} as const;

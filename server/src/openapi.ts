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

/** A lookup row from the registry (code + display name + optional lifecycle flag). */
export type LookupOption = { code: string; name: string; flag?: string };

/** Live lookup option lists injected into the spec; any omitted set degrades to a free-form string param. */
export interface SpecOptions {
  status?: ReadonlyArray<LookupOption>;
  municipalities?: ReadonlyArray<LookupOption>;
}

/**
 * Build an enumerated query parameter from live lookup values. When values are
 * present we model it as a comma-joined array whose items enumerate every NAME
 * (style:form, explode:false serialises to `?status=ACTIVE,FROZEN`) and list the
 * full set in the description. Without values (registry unreachable at build
 * time) it degrades to the free-form `fallback` string param. Codes — and, when
 * present, lifecycle flags — are also accepted at runtime regardless.
 */
function enumeratedParam(
  name: string,
  values: ReadonlyArray<LookupOption> | undefined,
  opts: { intro: string; fallback: string; example: string; groupByFlag?: boolean },
) {
  const base = { name, in: "query", required: false } as const;
  if (!values || values.length === 0) {
    return { ...base, description: opts.fallback, schema: { type: "string", example: opts.example } };
  }
  const hasFlags = Boolean(opts.groupByFlag && values.some((v) => v.flag));
  let listing: string;
  if (hasFlags) {
    const byFlag = new Map<string, string[]>();
    for (const v of values) {
      const f = v.flag || "Other";
      (byFlag.get(f) ?? byFlag.set(f, []).get(f)!).push(v.name);
    }
    listing = [...byFlag.entries()].map(([flag, names]) => `- **${flag}** (${names.length}): ${names.join(", ")}`).join("\n");
  } else {
    listing = values.map((v) => `- ${v.name}`).join("\n");
  }
  return {
    ...base,
    description: `${opts.intro}\n\nAll ${values.length} options${hasFlags ? ", grouped by lifecycle flag" : ""}:\n${listing}`,
    schema: { type: "array", items: { type: "string", enum: values.map((v) => v.name) }, example: [opts.example] },
    style: "form",
    explode: false,
  };
}

/** Search parameters with the (optionally live) enumerated params spliced in by name. */
function buildSearchParams(options: SpecOptions = {}) {
  const replace: Record<string, ReturnType<typeof enumeratedParam>> = {
    status: enumeratedParam("status", options.status, {
      intro:
        "Filter by commercial-registration status. Accepts status name(s) or numeric code(s), case-insensitive, comma-separated for multiple (e.g. `ACTIVE,FROZEN`). You can also pass a lifecycle flag (`Active` or `Deleted`) to match every status in that group.",
      fallback: "Status name(s) or code(s); names resolve case-insensitively (e.g. ACTIVE). Comma-separate for multiple.",
      example: "ACTIVE",
      groupByFlag: true,
    }),
    municipality: enumeratedParam("municipality", options.municipalities, {
      intro: "Filter by municipality. Accepts municipality name(s) or code(s), case-insensitive, comma-separated for multiple.",
      fallback: "Municipality by name or code (see /lookups/municipality)",
      example: "Manama Municipality",
    }),
  };
  return [...filterParams.map((p) => replace[p.name] ?? p), ...pagingParams];
}

const pagingParams = [
  { name: "page", in: "query", description: "Page number (default 1).", schema: { type: "integer", default: 1, minimum: 1 } },
  { name: "per_page", in: "query", description: "Results per page (default 25, max 200). Alias: limit.", schema: { type: "integer", default: 25, minimum: 1, maximum: 200 } },
  { name: "all", in: "query", description: "Set to 1 to page through every match (bounded by max_scan_pages).", schema: { type: "string", enum: ["0", "1"] } },
  { name: "max_scan_pages", in: "query", description: "Max pages to fetch when all=1 (default 20).", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
  { name: "fields", in: "query", description: "Comma-separated result fields to return (e.g. cr_number,name_en,status).", schema: { type: "string" } },
  { name: "lang", in: "query", description: "Set to 'ar' to match Arabic-culture names.", schema: { type: "string", enum: ["en", "ar"] } },
];

export function buildOpenApiSpec(options: SpecOptions = {}) {
  return {
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
        parameters: buildSearchParams(options),
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
        description: "Returns ISIC4 {code,name} matches from the registry's live activity search (source: 'live'); falls back to a bundled offline table with synonym aliases if the live endpoint is unreachable or has no match (source: 'offline_fallback'). Use the code with /search?activity=<code>; /search?activity=<name> also resolves automatically. Raw ISIC4 codes always work.",
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
  };
}

/** Static base spec (no live enums) — the offline fallback when lookups are unreachable. */
export const openapiSpec = buildOpenApiSpec();

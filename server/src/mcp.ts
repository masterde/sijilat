// MCP server (stdio) exposing Sijilat business search + contact lookup to
// agents. Talks to the registry directly through SijilatClient — no dependency
// on the hosted HTTP API. Run: `npm run mcp` (dev) or `node dist/mcp.js`.
//
// stdout is the MCP transport: never console.log here; use console.error.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SijilatClient, type Company, type SearchFilters } from "./sijilat.js";
import { getContacts, hasAnyPhone, mapLimit } from "./contacts.js";

const client = new SijilatClient();
// Detail calls per find_business_phones invocation run with this concurrency;
// the client's RateLimiter still caps total upstream concurrency.
const ENRICH_CONCURRENCY = 4;


// Shared search filters. `sector` is deliberately not exposed: combined with a
// status filter the upstream hangs (see ARCHITECTURE.md); `activity` covers it.
const filterShape = {
  name: z.string().optional().describe("Business name (English), partial match, e.g. 'almoayyed'"),
  name_ar: z.string().optional().describe("Business name in Arabic, partial match"),
  activity: z
    .string()
    .optional()
    .describe(
      "Business activity keyword(s) or ISIC4 code(s), comma-separated, e.g. 'restaurant' or '5610-3'. " +
        "The registry matches single words best ('rental', not 'car rental'); if a search returns 0, " +
        "use search_activities to find exact codes",
    ),
  municipality: z.string().optional().describe("Municipality / governorate name or code, e.g. 'Capital'"),
  block: z.string().optional().describe("Address block number, e.g. '264'"),
  company_type: z.string().optional().describe("Company type name or code, e.g. 'With Limited Liability Company'"),
  status: z
    .string()
    .default("ACTIVE")
    .describe("Registration status name or code. Defaults to ACTIVE; pass '' for any status"),
  cr_number: z.string().optional().describe("Exact commercial registration (CR) number"),
};

type FilterArgs = { [K in keyof typeof filterShape]: z.infer<(typeof filterShape)[K]> };

function toFilters(a: FilterArgs): SearchFilters {
  return {
    nameEn: a.name,
    nameAr: a.name_ar,
    activity: a.activity,
    municipality: a.municipality,
    block: a.block,
    type: a.company_type,
    status: a.status || undefined,
    crNumber: a.cr_number,
  };
}

function hasFilter(a: FilterArgs): boolean {
  return !!(a.name || a.name_ar || a.activity || a.municipality || a.block || a.company_type || a.cr_number);
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const summarize = (c: Company) => ({
  cr_number: c.cr_number,
  branch: c.branch,
  name_en: c.name_en,
  name_ar: c.name_ar,
  status: c.status,
  company_type: c.company_type,
  activities: c.activities,
});

const server = new McpServer({ name: "sijilat", version: "0.1.0" });
const readOnly = { readOnlyHint: true, openWorldHint: true };

server.registerTool(
  "search_businesses",
  {
    title: "Search Bahrain businesses",
    description:
      "Search Bahrain's Sijilat commercial registry. Returns CR number + branch for each match (no contact " +
      "details — use get_business_contacts or find_business_phones for phone numbers). At least one filter " +
      "besides status is required.",
    inputSchema: {
      ...filterShape,
      limit: z.number().int().min(1).max(50).default(10).describe("Results per page (max 50)"),
      page: z.number().int().min(1).default(1).describe("1-based page number"),
    },
    annotations: readOnly,
  },
  async (args) => {
    if (!hasFilter(args)) return fail("Provide at least one filter (name, name_ar, activity, municipality, block, company_type, cr_number).");
    try {
      const { results, total } = await client.search(toFilters(args), { page: args.page, perPage: args.limit });
      return json({
        total,
        page: args.page,
        has_more: args.page * args.limit < total,
        results: results.map(summarize),
      });
    } catch (e) {
      return fail(`Search failed: ${errMsg(e)}`);
    }
  },
);

server.registerTool(
  "get_business_contacts",
  {
    title: "Get a business's phone numbers and contacts",
    description:
      "Fetch phone, mobile, fax, email, website and address for one registered business by CR number " +
      "(and branch), plus `owner_contact`: the phone/mobile on the CR's latest GET LICENSE application, " +
      "which is usually the owner's own number (null if the CR never filed one). Phone numbers are " +
      "normalised to E.164 (e.g. +97317211211).",
    inputSchema: {
      cr_number: z.string().min(1).describe("Commercial registration number, e.g. '1427'"),
      branch: z.string().default("1").describe("Branch number (default '1', the main branch)"),
    },
    annotations: readOnly,
  },
  async ({ cr_number, branch }) => {
    try {
      return json(await getContacts(client, cr_number.trim(), branch.trim() || "1"));
    } catch (e) {
      return fail(`Lookup failed for CR ${cr_number}-${branch}: ${errMsg(e)}`);
    }
  },
);

server.registerTool(
  "find_business_phones",
  {
    title: "Search businesses and return their phone numbers",
    description:
      "One-shot: search the registry and fetch contact details (phone, mobile, email, ...) for each match. " +
      "Each match costs 1 extra registry call (3 with include_owner_phone), so keep limit small (max 25) " +
      "and page through. For thousands of businesses use the bulk export script instead " +
      "(server/scripts/export-contacts.mts).",
    inputSchema: {
      ...filterShape,
      limit: z.number().int().min(1).max(25).default(10).describe("Max businesses to enrich (max 25)"),
      page: z.number().int().min(1).default(1).describe("1-based page of search results to enrich"),
      include_owner_phone: z
        .boolean()
        .default(true)
        .describe("Also fetch owner_contact from the GET LICENSE application (2 extra calls per business)"),
      only_with_phone: z
        .boolean()
        .default(false)
        .describe("Drop businesses with no phone/mobile at all (business or owner)"),
    },
    annotations: readOnly,
  },
  async (args) => {
    if (!hasFilter(args)) return fail("Provide at least one filter (name, name_ar, activity, municipality, block, company_type, cr_number).");
    try {
      const { results, total } = await client.search(toFilters(args), { page: args.page, perPage: args.limit });
      const enriched = await mapLimit(results, ENRICH_CONCURRENCY, async (c) => {
        try {
          return await getContacts(client, c.cr_number, c.branch || "1", args.include_owner_phone);
        } catch (e) {
          return { cr_number: c.cr_number, branch: c.branch, name_en: c.name_en, name_ar: c.name_ar, status: c.status, error: errMsg(e) };
        }
      });
      const rows = args.only_with_phone
        ? enriched.filter((r) => !("error" in r) && hasAnyPhone(r))
        : enriched;
      return json({
        total_matches: total,
        page: args.page,
        has_more: args.page * args.limit < total,
        returned: rows.length,
        results: rows,
      });
    } catch (e) {
      return fail(`Search failed: ${errMsg(e)}`);
    }
  },
);

server.registerTool(
  "search_activities",
  {
    title: "Look up business activity (ISIC4) codes",
    description:
      "Find registry activity codes for a keyword (e.g. 'restaurant', 'bakery', 'rental'). Use the returned " +
      "codes as the `activity` filter for precise searches. Single words match best.",
    inputSchema: { keyword: z.string().min(1).describe("Activity keyword in English (single word works best)") },
    annotations: readOnly,
  },
  async ({ keyword }) => {
    try {
      const hits = await client.searchActivitiesLive(keyword);
      return json(hits.map((h) => ({ code: h.code, name: h.name, name_ar: h.flag })));
    } catch (e) {
      return fail(`Activity search failed: ${errMsg(e)}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("sijilat MCP server running on stdio");

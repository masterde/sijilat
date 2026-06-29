// Hono app exposing the Sijilat registry as a JSON HTTP API.
// Deploy-anywhere: imported by src/server.ts (Node) and api/index.ts (Vercel).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { timingSafeEqual } from "node:crypto";
import { SijilatClient, SijilatError, RateLimitError, type SearchFilters } from "./sijilat.js";
import { parseDetail } from "./detail.js";
import { apiReference } from "@scalar/hono-api-reference";
import { searchActivities, activityTableSize } from "./activities.js";
import { openapiSpec } from "./openapi.js";

/** Constant-time string compare that doesn't leak length-mismatch timing. */
function secretEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// One client per process so the bearer token + lookup tables are cached across
// requests (and across warm serverless invocations).
const client = new SijilatClient();

export const app = new Hono();

app.use("*", logger());
app.use("*", cors());

// Optional API key: when SIJILAT_API_KEY is set, require a matching x-api-key
// HEADER. When unset, the API is open (fine for local/private use). The key is
// only accepted as a header — never a query parameter — so it does not leak
// into access logs, the request URL, or referrers.
app.use("*", async (c, next) => {
  const required = process.env.SIJILAT_API_KEY;
  if (!required) return next();
  // Discovery/docs endpoints stay public even when a key is set.
  const open = new Set(["/", "/health", "/docs", "/openapi.json"]);
  if (open.has(c.req.path)) return next();
  const provided = c.req.header("x-api-key") ?? "";
  if (!secretEqual(provided, required)) {
    return c.json({ error: "unauthorized", message: "missing or invalid x-api-key header" }, 401);
  }
  return next();
});

app.get("/", (c) =>
  c.json({
    name: "sijilat-api",
    description: "Query Bahrain's Sijilat commercial registry",
    docs: "/docs",
    openapi: "/openapi.json",
    endpoints: {
      "GET /health": "liveness + registry reachability",
      "GET /search": "search CRs — filters: name_en, name_ar, cr, status, type, nationality, sector, activity, municipality, partner, partner_cr, reg_from, reg_to, road, flat, block, building, passport; paging: page, per_page, all, max_scan_pages, fields, lang. Names are case-insensitive and comma-separable.",
      "GET /company/:cr": "full company profile (query: branch, raw)",
      "GET /lookups": "all filter code tables",
      "GET /lookups/activity?q=": "search business activities (ISIC4) by name",
      "GET /lookups/:table": "one table: status|type|nationality|sector|municipality",
    },
    auth: process.env.SIJILAT_API_KEY ? "x-api-key required (header)" : "open",
  }),
);

app.get("/health", async (c) => {
  try {
    // A cheap reachability check: fetch lookups (also warms the token cache).
    const lt = await client.lookups();
    return c.json({ ok: true, registry: "reachable", status_codes: lt.status.length });
  } catch (err) {
    return c.json({ ok: false, registry: "unreachable", error: errMessage(err) }, 503);
  }
});

app.get("/search", async (c) => {
  const q = c.req.query();
  const filters: SearchFilters = {
    nameEn: q.name_en,
    nameAr: q.name_ar,
    crNumber: q.cr,
    status: q.status,
    type: q.type,
    municipality: q.municipality,
    block: q.block,
    nationality: q.nationality,
    sector: q.sector,
    activity: q.activity,
    partnerEn: q.partner,
    partnerAr: q.partner_ar,
    partnerNat: q.partner_nat,
    partnerCr: q.partner_cr,
    regFrom: q.reg_from,
    regTo: q.reg_to,
    road: q.road,
    flat: q.flat,
    building: q.building,
    passport: q.passport,
  };
  if (!Object.values(filters).some(Boolean)) {
    return c.json(
      { error: "bad_request", message: "supply at least one filter (e.g. ?name_en=trading, ?cr=21, ?sector=Manufacturing, ?activity=restaurant)" },
      400,
    );
  }
  const fields = parseFields(q.fields);
  const langAr = q.lang === "ar";
  const all = q.all === "1" || q.all === "true";
  const perPage = clampInt(q.per_page ?? q.limit, 25, 1, 200);
  const page = clampInt(q.page, 1, 1, 100000);
  const maxScanPages = clampInt(q.max_scan_pages, 20, 1, 100);

  // The registry upstream cannot combine sector (FIRST_LEV) with status — that
  // pair hangs (>25s) regardless of result size. Apply status client-side over
  // a fast sector-only query instead. This keeps "active companies in sector X"
  // — the canonical lead-gen query — working.
  if (filters.sector && filters.status) {
    return handle(c, async () => {
      const r = await sectorStatusSearch(filters, q.status!, { all, page, perPage, maxScanPages, langAr });
      const base = {
        source: "live",
        sector_total: r.sectorTotal,
        status_filter: "applied client-side (the registry cannot combine sector + status)",
        scanned: r.scanned,
        returned: r.matches.length,
        results: pick(r.matches, fields),
      };
      return all ? { ...base, all: true } : { ...base, page, per_page: perPage, has_more: r.hasMore };
    });
  }

  return handle(c, async () => {
    if (all) {
      const { results, total } = await client.searchAll(filters, {
        perPage: 100,
        maxItems: -1,
        maxScanPages,
        langAr,
      });
      return {
        source: "live",
        total_matches: total,
        returned: results.length,
        all: true,
        capped: results.length < total,
        results: pick(results, fields),
      };
    }
    const { results, total } = await client.search(filters, { page, perPage, langAr });
    return {
      source: "live",
      total_matches: total,
      page,
      per_page: perPage,
      returned: results.length,
      has_more: page * perPage < total,
      results: pick(results, fields),
    };
  });
});

app.get("/company/:cr", async (c) => {
  const cr = c.req.param("cr");
  const branch = c.req.query("branch") || "1";
  const raw = c.req.query("raw") === "1" || c.req.query("raw") === "true";
  return handle(c, async () => {
    const data = await client.detail(cr, branch);
    return raw ? data : parseDetail(data);
  });
});

app.get("/lookups", async (c) => handle(c, () => client.lookups()));

// Activity (ISIC4) keyword search via the registry's live activity endpoint —
// must be registered before the /lookups/:table param route so "activity"
// doesn't fall through. Falls back to the bundled offline table if the live
// endpoint is unreachable.
app.get("/lookups/activity", (c) => {
  const query = c.req.query("q") ?? "";
  if (!query.trim()) {
    return c.json(
      {
        table: "activity",
        note: "pass ?q=<text> to search business activities by name (e.g. ?q=restaurant), powered by the registry's live activity search. Use the returned code with /search?activity=<code>; activity=<name> also resolves automatically.",
      },
      200,
    );
  }
  return handle(c, async () => {
    const limit = clampInt(c.req.query("limit"), 50, 1, 500);
    let live: Awaited<ReturnType<typeof client.searchActivitiesLive>> = [];
    try {
      live = await client.searchActivitiesLive(query);
    } catch {
      // fall through to offline table below
    }
    if (live.length) {
      return { table: "activity", query, source: "live", count: live.length, values: live.slice(0, limit) };
    }
    // Live found nothing (or was unreachable): offline table + synonym aliases.
    const values = searchActivities(query, limit);
    return { table: "activity", query, source: "offline_fallback", count: values.length, values, total_indexed: activityTableSize() };
  });
});

app.get("/lookups/:table", async (c) => {
  const key = c.req.param("table").toLowerCase();
  const alias: Record<string, keyof Awaited<ReturnType<SijilatClient["lookups"]>>> = {
    status: "status",
    type: "types",
    types: "types",
    nationality: "nationalities",
    sector: "sectors",
    municipality: "municipalities",
  };
  const field = alias[key];
  if (!field) {
    return c.json({ error: "bad_request", message: "unknown table; use status|type|nationality|sector|municipality" }, 400);
  }
  return handle(c, async () => {
    const lt = await client.lookups();
    const values = lt[field];
    return { table: key, count: values.length, values };
  });
});

// OpenAPI spec + interactive docs. The docs UI is served from the bundled
// @scalar/hono-api-reference (no external CDN script), so there is no
// third-party-script / SRI exposure.
app.get("/openapi.json", (c) => c.json(openapiSpec));
app.get("/docs", apiReference({ spec: { url: "/openapi.json" }, pageTitle: "Sijilat API — Docs" }));

// --- helpers ---------------------------------------------------------------

/** Parse a comma-separated `fields=` list into a trimmed key array (or null). */
function parseFields(v: string | undefined): string[] | null {
  if (!v) return null;
  const keys = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return keys.length ? keys : null;
}

/** Project each record down to the requested fields (no-op when fields is null). */
function pick<T extends object>(rows: T[], fields: string[] | null): Array<Record<string, unknown>> | T[] {
  if (!fields) return rows;
  return rows.map((row) => {
    const src = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of fields) {
      if (k in src) out[k] = src[k];
    }
    return out;
  });
}

/**
 * Sector + status search via a fast sector-only query with the status applied
 * client-side, paging through results until the requested page is filled
 * (bounded by maxScanPages). Works around the upstream sector+status hang.
 */
async function sectorStatusSearch(
  filters: SearchFilters,
  statusQuery: string,
  opts: { all: boolean; page: number; perPage: number; maxScanPages: number; langAr: boolean },
) {
  // Resolve the requested status tokens (names, codes, or flags) to canonical
  // uppercase status names so we can match them against each row's status.
  const lt = await client.lookups();
  const wanted = new Set<string>();
  for (let tok of statusQuery.split(",")) {
    tok = tok.trim().replace(/'/g, "");
    if (!tok) continue;
    const byName = lt.status.find((s) => s.name.toLowerCase() === tok.toLowerCase());
    const byCode = lt.status.find((s) => s.code === tok);
    const byFlag = lt.status.filter((s) => s.flag && s.flag.toLowerCase() === tok.toLowerCase());
    if (byName) wanted.add(byName.name.toUpperCase());
    else if (byCode) wanted.add(byCode.name.toUpperCase());
    else if (byFlag.length) byFlag.forEach((s) => wanted.add(s.name.toUpperCase()));
    else wanted.add(tok.toUpperCase());
  }

  const sectorOnly: SearchFilters = { ...filters, status: undefined };
  const { all, page, perPage, langAr } = opts;
  // Bound per-request scanning so the serverless function stays well under
  // timeout; deep status-filtered pages return has_more so callers can continue.
  const scanCap = Math.min(opts.maxScanPages, all ? 12 : 8);
  const need = all ? Infinity : page * perPage;
  const matches: Array<Awaited<ReturnType<typeof client.search>>["results"][number]> = [];
  let sectorTotal = 0;
  let scanned = 0;
  let exhausted = false;
  for (let p = 1; p <= scanCap && matches.length < need; p++) {
    const { results, total } = await client.search(sectorOnly, { page: p, perPage: 100, langAr });
    sectorTotal = total;
    scanned += results.length;
    for (const r of results) if (wanted.has(r.status.toUpperCase())) matches.push(r);
    if (results.length < 100) {
      exhausted = true;
      break;
    }
  }
  const start = all ? 0 : (page - 1) * perPage;
  const slice = all ? matches : matches.slice(start, start + perPage);
  const hasMore = !exhausted || matches.length > (all ? 0 : page * perPage);
  return { matches: slice, sectorTotal, scanned, exhausted, hasMore };
}

async function handle(c: any, fn: () => Promise<unknown> | unknown) {
  try {
    return c.json((await fn()) as object);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json({ error: "rate_limited", message: err.message }, 429);
    }
    if (err instanceof SijilatError) {
      const code = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      return c.json({ error: "upstream_error", message: err.message }, code as any);
    }
    return c.json({ error: "internal_error", message: errMessage(err) }, 500);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = v ? parseInt(v, 10) : def;
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Default export so Vercel's zero-config Hono preset can use this module as the
// serverless function entry (it wraps the app's fetch handler). The named
// export above is what src/server.ts uses for the long-lived Node server.
export default app;

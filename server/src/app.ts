// Hono app exposing the Sijilat registry as a JSON HTTP API.
// Deploy-anywhere: imported by src/server.ts (Node) and api/index.ts (Vercel).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { timingSafeEqual } from "node:crypto";
import { SijilatClient, SijilatError, RateLimitError, type SearchFilters } from "./sijilat.js";
import { parseDetail } from "./detail.js";

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
  if (c.req.path === "/" || c.req.path === "/health") return next();
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
    endpoints: {
      "GET /health": "liveness + registry reachability",
      "GET /search": "search CRs (query params: name_en, name_ar, cr, status, type, nationality, sector, activity, partner, partner_cr, reg_from, reg_to, road, block, building, passport, limit, all, max_scan_pages, lang)",
      "GET /company/:cr": "full company profile (query: branch, raw)",
      "GET /lookups": "all filter code tables",
      "GET /lookups/:table": "one table: status|type|nationality|sector|municipality",
    },
    auth: process.env.SIJILAT_API_KEY ? "x-api-key required" : "open",
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
    building: q.building,
    passport: q.passport,
  };
  if (!Object.values(filters).some(Boolean)) {
    return c.json({ error: "bad_request", message: "supply at least one filter, e.g. ?name_en=trading or ?cr=21" }, 400);
  }
  const limit = clampInt(q.limit, 25, 1, 1000);
  const all = q.all === "1" || q.all === "true";
  const maxScanPages = clampInt(q.max_scan_pages, 20, 1, 100);
  const langAr = q.lang === "ar";

  return handle(c, async () => {
    const { results, total } = await client.searchAll(filters, {
      perPage: 50,
      maxItems: all ? -1 : limit,
      maxScanPages,
      langAr,
    });
    return { source: "live", total_matches: total, returned: results.length, results };
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

// --- helpers ---------------------------------------------------------------

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

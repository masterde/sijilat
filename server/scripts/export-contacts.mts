// Bulk export: every business matching a filter, enriched with business +
// owner (GET LICENSE) contacts. Resumable — appends to <out>.jsonl and skips
// CR-branches already there, so re-run the same command after an interruption.
// Writes <out>.csv from the JSONL at the end.
//
//   npx tsx scripts/export-contacts.mts --activity 5610-1 --out exports/5610-1
//   options: --block 264  --status ACTIVE ('' = any)  --limit N  --concurrency 4  --no-owner
//            --per-minute 120 (registry calls per rolling minute; raise with care)
//
// Cost: 1 detail call per business, +2 with owner lookup (the default). At the
// default 120 calls/min that's ~40 businesses/min with owners. If the registry
// starts refusing requests (403) the run stops; re-run later to resume.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { SijilatClient, isUpstreamStop, type Company } from "../src/sijilat.js";
import { getContacts, mapLimit, type Contacts } from "../src/contacts.js";

const { values: opt } = parseArgs({
  options: {
    activity: { type: "string" },
    name: { type: "string" },
    municipality: { type: "string" },
    block: { type: "string" },
    status: { type: "string", default: "ACTIVE" },
    out: { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "per-minute": { type: "string" },
    "per-page": { type: "string", default: "100" },
    "no-owner": { type: "boolean", default: false },
  },
});
if (!opt.out || !(opt.activity || opt.name || opt.municipality || opt.block)) {
  console.error("usage: export-contacts.mts --activity <code|keyword> [--name ..] [--municipality ..] [--block ..] --out <path-prefix>");
  process.exit(2);
}

// Batch job: wait as long as needed for budget instead of failing calls.
const client = new SijilatClient(undefined, {
  maxWaitMs: Infinity,
  ...(opt["per-minute"] && { perMinute: Number(opt["per-minute"]) }),
});
const jsonlPath = `${opt.out}.jsonl`;
const csvPath = `${opt.out}.csv`;
mkdirSync(dirname(jsonlPath), { recursive: true });

const key = (cr: string, br: string) => `${cr}-${br || "1"}`;
const readRows = (): (Contacts & { error?: string })[] =>
  existsSync(jsonlPath)
    ? readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
// Errored rows are retried on the next run.
const done = new Set(readRows().filter((r) => !r.error).map((r) => key(r.cr_number, r.branch)));

const filters = {
  activity: opt.activity,
  nameEn: opt.name,
  municipality: opt.municipality,
  block: opt.block,
  status: opt.status || undefined,
};
const perPage = Number(opt["per-page"]);
const limit = opt.limit ? Number(opt.limit) : Infinity;

// 1. Collect the full match list (cheap: one call per page).
const matches: Company[] = [];
try {
  for (let page = 1; matches.length < limit; page++) {
    const { results, total } = await client.search(filters, { page, perPage });
    if (page === 1) console.error(`matches: ${total}`);
    matches.push(...results);
    if (results.length < perPage) break;
  }
} catch (e) {
  if (!isUpstreamStop(e)) throw e;
  console.error(`stopped while listing matches: ${e.message}. Re-run the same command later.`);
  process.exit(3);
}
const todo = matches.slice(0, limit).filter((c) => !done.has(key(c.cr_number, c.branch)));
console.error(`already exported: ${done.size}, to fetch: ${todo.length}`);

// 2. Enrich with bounded concurrency, appending each row as it lands.
let n = 0;
let stopped: Error | undefined;
await mapLimit(todo, Number(opt.concurrency), async (c) => {
  if (stopped) return;
  let row: object;
  try {
    row = await getContacts(client, c.cr_number, c.branch || "1", !opt["no-owner"]);
  } catch (e) {
    // Registry refusing us: stop without writing error rows; a re-run resumes.
    if (isUpstreamStop(e)) {
      stopped ??= e;
      return;
    }
    row = { cr_number: c.cr_number, branch: c.branch, name_en: c.name_en, error: e instanceof Error ? e.message : String(e) };
  }
  appendFileSync(jsonlPath, JSON.stringify(row) + "\n");
  if (++n % 25 === 0 || n === todo.length) console.error(`${n}/${todo.length}`);
});

// 3. CSV of the latest row per CR-branch.
const latest = new Map<string, Contacts & { error?: string }>();
for (const r of readRows()) latest.set(key(r.cr_number, r.branch), r);
const cols = [
  "cr_number", "branch", "name_en", "name_ar", "status", "phone", "mobile", "fax", "email", "website", "address",
  "owner_phone", "owner_mobile", "owner_email", "owner_application_no", "owner_filed_on", "error",
];
const cell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  // Registry text is user-entered: neutralise spreadsheet formulas (=, +, -, @,
  // tab, CR). Normalised E.164 phones ("+973...") are left dialable.
  if (/^[=+\-@\t\r]/.test(s) && !/^\+\d+$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const lines = [cols.join(",")];
for (const r of latest.values()) {
  const o = r.owner_contact ?? undefined;
  const flat: Record<string, unknown> = {
    ...r,
    owner_phone: o?.phone,
    owner_mobile: o?.mobile,
    owner_email: o?.email,
    owner_application_no: o?.application_no,
    owner_filed_on: o?.filed_on,
  };
  lines.push(cols.map((c) => cell(flat[c])).join(","));
}
writeFileSync(csvPath, "﻿" + lines.join("\n") + "\n"); // BOM so Excel reads the Arabic names
const errors = [...latest.values()].filter((r) => r.error).length;
console.error(`wrote ${latest.size} rows to ${csvPath}${errors ? ` (${errors} errors — re-run to retry)` : ""}`);
if (stopped) {
  console.error(`stopped early after ${n}/${todo.length}: ${stopped.message}. Re-run the same command later to resume.`);
  process.exit(3);
}

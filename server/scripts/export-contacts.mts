// Bulk export: every business matching a filter, enriched with business +
// owner (GET LICENSE) contacts. Resumable — appends to <out>.jsonl and skips
// CR-branches already there, so re-run the same command after an interruption.
// Writes <out>.csv from the JSONL at the end.
//
//   npx tsx scripts/export-contacts.mts --activity 5610-1 --out exports/5610-1
//   options: --block 264  --status ACTIVE ('' = any)  --limit N  --concurrency 4  --no-owner
//
// Cost: 1 detail call per business, +2 with owner lookup (the default).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { SijilatClient, type Company } from "../src/sijilat.js";
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
    "per-page": { type: "string", default: "100" },
    "no-owner": { type: "boolean", default: false },
  },
});
if (!opt.out || !(opt.activity || opt.name || opt.municipality || opt.block)) {
  console.error("usage: export-contacts.mts --activity <code|keyword> [--name ..] [--municipality ..] [--block ..] --out <path-prefix>");
  process.exit(2);
}

const client = new SijilatClient();
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
for (let page = 1; matches.length < limit; page++) {
  const { results, total } = await client.search(filters, { page, perPage });
  if (page === 1) console.error(`matches: ${total}`);
  matches.push(...results);
  if (results.length < perPage) break;
}
const todo = matches.slice(0, limit).filter((c) => !done.has(key(c.cr_number, c.branch)));
console.error(`already exported: ${done.size}, to fetch: ${todo.length}`);

// 2. Enrich with bounded concurrency, appending each row as it lands.
let n = 0;
await mapLimit(todo, Number(opt.concurrency), async (c) => {
  let row: object;
  try {
    row = await getContacts(client, c.cr_number, c.branch || "1", !opt["no-owner"]);
  } catch (e) {
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
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

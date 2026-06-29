// One-time(ish) harvest of the registry's ISIC4 business-activity codes.
//
// The registry exposes no public "list/search activities" endpoint (the site's
// activity picker calls a bundled-only endpoint). But every company detail
// carries its activities as {ISIC4_CD, ISIC4_NM}. This script crawls a bounded,
// sector-spanning sample of companies, collects the distinct activity codes, and
// writes them to src/data/isic4.json so the API can resolve activity names ->
// codes offline. Re-run to expand coverage.
//
// Usage:  node scripts/harvest-isic4.mjs [companiesPerSector]
// Polite: small fixed delay between calls; bounded total.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { SijilatClient } from "../dist/sijilat.js";

const PER_SECTOR = Number(process.argv[2] ?? 3);
const SECTORS = Array.from({ length: 18 }, (_, i) => String(i + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new SijilatClient();
const byCode = new Map();

// Seed with anything already harvested so re-runs accumulate.
try {
  const existing = JSON.parse(await readFile(new URL("../src/data/isic4.json", import.meta.url)));
  for (const a of existing) byCode.set(a.code, a);
} catch {}

let detailCalls = 0;
for (const sector of SECTORS) {
  let companies = [];
  try {
    // Sector-only (no status) — the combined sector+status query is the slow
    // one we're separately fixing; sector alone is reliable.
    const { results } = await client.searchAll(
      { sector },
      { perPage: 10, maxItems: PER_SECTOR, maxScanPages: 1 },
    );
    companies = results;
  } catch (e) {
    console.error(`sector ${sector} search failed: ${e.message}`);
    continue;
  }
  for (const c of companies) {
    await sleep(300);
    try {
      const jd = await client.detail(c.cr_number, c.branch);
      detailCalls++;
      const acts = Array.isArray(jd?.businessActivities) ? jd.businessActivities : [];
      for (const a of acts) {
        const code = (a.ISIC4_CD ?? "").trim();
        const name = (a.ISIC4_NM ?? "").trim();
        if (code && name && !byCode.has(code)) {
          byCode.set(code, { code, name, sector });
        }
      }
    } catch (e) {
      console.error(`detail ${c.cr_number}/${c.branch} failed: ${e.message}`);
    }
  }
  console.error(`sector ${sector}: ${companies.length} companies; total codes so far ${byCode.size}`);
}

const out = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
await mkdir(new URL("../src/data/", import.meta.url), { recursive: true });
await writeFile(new URL("../src/data/isic4.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.error(`\nWrote src/data/isic4.json: ${out.length} distinct activity codes from ${detailCalls} detail calls.`);

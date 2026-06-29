// Business-activity (ISIC4) name <-> code resolution.
//
// The registry has no public activity-list endpoint, so a bundled table
// (src/data/isic4.json, built by scripts/harvest-isic4.mjs) maps activity names
// to ISIC4 codes. `activity=<code>` always passes through unchanged; this layer
// only resolves human-readable names. Coverage is "common activities"; raw codes
// are the universal fallback.

import isic4 from "./data/isic4.json" with { type: "json" };

export interface Activity {
  code: string;
  name: string;
  sector?: string;
}

const TABLE: Activity[] = isic4 as Activity[];

export function activityTableSize(): number {
  return TABLE.length;
}

// An ISIC4 code looks like "521-1" / "521" / "522901" — digits with an optional
// "-N" suffix. Anything matching is treated as already-resolved.
const CODE_RE = /^[0-9]+(-[0-9]+)?$/;
const isCode = (s: string) => CODE_RE.test(s);

// Light stemming so "warehouse" matches "warehousing", "trade" matches "trading",
// etc. — drops common English suffixes before substring comparison.
const stem = (s: string) => s.toLowerCase().replace(/(ing|ies|es|s|e)$/u, "");
const matchesActivity = (name: string, needle: string) => {
  const n = name.toLowerCase();
  return n.includes(needle) || n.includes(stem(needle)) || stem(n).includes(stem(needle));
};

/** Full-text search over the activity table (case-insensitive, lightly stemmed). */
export function searchActivities(q: string, limit = 50): Activity[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: Activity[] = [];
  for (const a of TABLE) {
    if (a.code === needle || matchesActivity(a.name, needle)) {
      out.push(a);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Resolves a comma-separated list of activity names/codes to ISIC4 codes.
 * Codes pass through. Names resolve by exact (case-insensitive) match, else a
 * unique substring match, else are left as typed (so the caller still gets a
 * deterministic — if empty — upstream result rather than a silent guess).
 */
export function resolveActivityNames(value?: string): string {
  if (!value) return "";
  const out: string[] = [];
  for (let tok of value.split(",")) {
    tok = tok.trim().replace(/'/g, "");
    if (!tok) continue;
    if (isCode(tok)) {
      out.push(tok);
      continue;
    }
    const lower = tok.toLowerCase();
    const exact = TABLE.filter((a) => a.name.toLowerCase() === lower);
    if (exact.length) {
      out.push(...exact.map((a) => a.code));
      continue;
    }
    const sub = TABLE.filter((a) => matchesActivity(a.name, lower));
    if (sub.length) {
      // Use every substring match so "restaurant" maps to all matching ISIC4
      // codes (the registry treats multiple codes as OR).
      out.push(...sub.map((a) => a.code));
      continue;
    }
    out.push(tok);
  }
  // De-dupe while preserving order.
  return [...new Set(out)].join(",");
}

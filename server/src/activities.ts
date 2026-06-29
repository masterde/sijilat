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

// Synonym map from everyday terms to the phrasing the registry actually uses.
// The registry follows the ISIC4 international standard, whose category names
// rarely match how people search: there is no "restaurant" — it's "Food and
// beverage service activities"; no "IT" — it's "computer programming". Substring
// and stemming can't bridge that vocabulary gap, so each alias expands to one or
// more needles that DO appear in the ISIC4 names. Keys are matched on the whole
// (lowercased) token; values are substrings looked up in the activity table.
const ALIASES: Record<string, string[]> = {
  restaurant: ["food and beverage service", "catering"],
  restaurants: ["food and beverage service", "catering"],
  cafe: ["food and beverage service"],
  cafeteria: ["food and beverage service"],
  coffee: ["food and beverage service"],
  coffeeshop: ["food and beverage service"],
  eatery: ["food and beverage service"],
  dining: ["food and beverage service"],
  "fast food": ["food and beverage service"],
  takeaway: ["food and beverage service"],
  catering: ["catering"],
  grocery: ["sale/trade of food"],
  groceries: ["sale/trade of food"],
  supermarket: ["sale/trade of food"],
  foodstuff: ["sale/trade of food", "food and beverage"],
  it: ["computer", "information technology", "software"],
  software: ["computer programming", "software", "information technology"],
  tech: ["computer", "information technology"],
  ecommerce: ["retail sale via", "internet"],
  "e-commerce": ["retail sale via", "internet"],
  online: ["retail sale via", "internet"],
  realestate: ["real estate"],
  property: ["real estate"],
  construction: ["construction", "building"],
  contractor: ["construction", "contracting"],
  logistics: ["freight", "transport", "warehousing"],
  shipping: ["freight", "sea", "water transport"],
  salon: ["beauty", "hairdressing", "physical well-being"],
  barber: ["hairdressing"],
  gym: ["fitness", "sports"],
  clinic: ["medical", "human health"],
  pharmacy: ["pharmaceutical", "dispensing"],
  hotel: ["accommodation", "hotel"],
  car: ["motor vehicle"],
  garage: ["motor vehicle", "repair"],
  cleaning: ["cleaning"],
  laundry: ["washing", "laundering", "textile"],
};

/**
 * Expand a search needle into the list of needles to actually match against
 * activity names: the original term plus any alias synonyms. Multi-word alias
 * keys (e.g. "fast food") are matched against the full token.
 */
function expandNeedles(needle: string): string[] {
  const key = needle.trim().toLowerCase();
  const aliases = ALIASES[key] ?? ALIASES[key.replace(/\s+/gu, "")];
  // When the term is a known alias, match the canonical expansions ONLY — not
  // the lay term. Lay terms are often short/ambiguous ("it" is a substring of
  // "digital", "security", ...) and would otherwise match unrelated activities.
  return aliases ? aliases : [key];
}

/** Full-text search over the activity table (case-insensitive, lightly stemmed). */
export function searchActivities(q: string, limit = 50): Activity[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const needles = expandNeedles(needle);
  const out: Activity[] = [];
  for (const a of TABLE) {
    if (a.code === needle || needles.some((n) => matchesActivity(a.name, n))) {
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
    const needles = expandNeedles(lower);
    const sub = TABLE.filter((a) => needles.some((n) => matchesActivity(a.name, n)));
    if (sub.length) {
      // Use every match (including alias synonyms) so "restaurant" maps to all
      // relevant ISIC4 codes (the registry treats multiple codes as OR).
      out.push(...sub.map((a) => a.code));
      continue;
    }
    out.push(tok);
  }
  // De-dupe while preserving order.
  return [...new Set(out)].join(",");
}

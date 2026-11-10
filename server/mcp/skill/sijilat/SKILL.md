---
name: sijilat
description: Find Bahrain businesses and their phone numbers (business and owner) in the Sijilat commercial registry via the sijilat MCP tools. Use when the user asks for companies, shops, restaurants or other businesses in Bahrain by name, activity / ISIC4 code, block, municipality or CR number, wants their contact details, or wants a call list / lead list / export of Bahraini businesses.
---

# Sijilat: Bahrain business search + phone numbers

The `sijilat` MCP server wraps Bahrain's Sijilat commercial registry. Its tools:

| Tool | Use it for | Cost |
|---|---|---|
| `search_activities(keyword)` | Turn a business type into exact ISIC4 codes | 1 call |
| `search_businesses(filters, limit≤50, page)` | Counts and lists (no contacts) | 1 call per page |
| `find_business_phones(filters, limit≤25, page)` | Lists **with** contacts | ~3 calls per business |
| `get_business_contacts(cr_number, branch)` | One known business | ~3 calls |

Filters: `name`, `name_ar`, `activity` (ISIC4 codes or keywords, comma-separated = OR),
`municipality`, `block`, `company_type`, `cr_number`, `status` (default `ACTIVE`; `""` = any).

If these tools aren't available, the MCP isn't installed. Tell the user to run:

```bash
claude mcp add --transport http sijilat https://sijilat-api.vercel.app/mcp
```

## Workflow

1. **Resolve the activity.** For "restaurants", "bakeries", "car rental" and similar,
   call `search_activities` first and pass the exact code(s) as `activity`. The
   registry matches **single English words** best: "rental" works, "car rental"
   returns nothing. Try the core noun, then synonyms. If the user gave a code
   (e.g. `5610-1`), use it as-is. Codes have sub-variants (`5610-1`, `5610-3`, ...),
   so confirm with the user when several look relevant.
2. **Size it.** `search_businesses` with `limit: 1` gives `total` cheaply. Report the
   count before fetching contacts.
3. **Narrow if large.** Add `block` (most precise) or `municipality`.
4. **Fetch contacts.** `find_business_phones` with `limit: 25`, incrementing `page`
   while `has_more`. Set `only_with_phone: true` for call lists.
5. **Hand off big jobs.** Above ~200 businesses, MCP paging gets slow (~3 registry
   calls each). Recommend the resumable bulk exporter, which writes CSV/JSONL:

   ```bash
   git clone https://github.com/masterde/sijilat && cd sijilat/server && npm ci
   npx tsx scripts/export-contacts.mts --activity 5610-1 --block 264 --out exports/5610-1_block-264
   ```

   It skips rows already exported, so re-running resumes it. Flags: `--status`,
   `--municipality`, `--name`, `--limit`, `--no-owner`.

## Reading results

- **One row = one branch** (`cr_number` + `branch`). A CR's branches usually share
  phones, so **de-duplicate by `cr_number`** for call lists and say how many
  branches each represents.
- **Business vs owner numbers.** `phone` / `mobile` / `email` are the commercial
  address contacts. `owner_contact` comes from the CR's latest **GET LICENSE**
  filing and is usually the owner's personal number. Present them as separate
  columns ("business mobile", "owner mobile"). When they're equal, say so once.
- **`owner_contact: null`** means the CR never filed a GET LICENSE online, which is
  typical of old, low-numbered CRs. It isn't an error, so don't retry.
- `owner_contact.filed_on` is when that number was recorded. Old filings may be stale.
- Phones are E.164 (`+973XXXXXXXX`). Missing fields are omitted, not empty.
- A row with `error` failed upstream. Retry that business once with
  `get_business_contacts`.

## Recipes

**"All restaurants in block 264 with phone numbers"**
`search_activities("restaurant")` → pick codes → `search_businesses({activity, block: "264", limit: 1})`
for the count → `find_business_phones({activity, block: "264", limit: 25, only_with_phone: true})`, paging.

**"Phone number for <company name>"**
`search_businesses({name})` → choose the right CR/branch (ask if ambiguous) → `get_business_contacts`.

**"Who owns / how do I reach the owner of CR 12345?"**
`get_business_contacts({cr_number: "12345"})` and report `owner_contact`. This server
doesn't return owner names; it returns contacts only.

## Limits: never hammer the registry

The server caps its registry traffic (about 120 calls/min) and opens a circuit
breaker when the registry starts refusing it (HTTP 403). A burst of ~900 calls
in 3 minutes once got the hosted server's IP blocked for every user.

- If a tool says **"the registry is refusing requests"** or **"budget
  exhausted"**, or a result has **`stopped_early`**: stop, tell the user, and
  give them the retry time. Never retry in a loop; that extends blocks.
- Page `find_business_phones` sequentially, never in parallel. Leave a few
  seconds between pages on big jobs.
- For hundreds of businesses or more, use the exporter: it paces itself and
  resumes after a stop.

## Gotchas

- Don't search by sector together with a status filter: the registry hangs on that
  combination. Use `activity` codes instead (the MCP doesn't expose sector for this reason).
- `name` is English partial match; use `name_ar` for Arabic names.
- Results include inactive businesses only if you pass `status: ""`.
- The registry is a public government source, but owner numbers are personal data.
  Use them for legitimate business contact, and don't publish them.

# Sijilat API

A small, deployable HTTP API for querying the Kingdom of Bahrain's **Sijilat**
commercial registry (`sijilat.bh`). It wraps the registry's undocumented JSON
API — handling the public token handshake and AES-encrypted detail requests
internally — and exposes clean REST endpoints. No registry account or key is
required (the service mints its own public token).

Built with [Hono](https://hono.dev) + TypeScript. Runs anywhere: local Node,
Docker/Fly/Render/Railway, or Vercel.

**Interactive docs:** `GET /docs` (Scalar UI) · **Spec:** `GET /openapi.json` (also `openapi.json` in this folder).

## Endpoints

| Method & path | Description |
|---|---|
| `GET /` | API info |
| `GET /health` | Liveness + registry reachability |
| `GET /search` | Search commercial registrations |
| `GET /company/:cr` | Full company profile (`?branch=`, `?raw=1`) |
| `GET /lookups` | All filter code tables |
| `GET /lookups/activity?q=` | Search business activities (ISIC4) by name |
| `GET /lookups/:table` | One table: `status\|type\|nationality\|sector\|municipality` |
| `GET /docs` | Interactive API reference |
| `GET /openapi.json` | OpenAPI 3.1 spec |

### `GET /search` query parameters

At least one filter is required. **All name filters are case-insensitive** and
accept comma-separated multiple values.

**Filters:** `name_en`, `name_ar`, `cr`, `status`, `type`, `nationality`,
`sector`, `activity`, `municipality`, `partner`, `partner_ar`, `partner_nat`,
`partner_cr`, `reg_from`, `reg_to`, `road`, `flat`, `block`, `building`,
`passport`.

**Paging & output:** `page` (default 1), `per_page` (default 25, max 200; alias
`limit`), `all=1` (page through every match, bounded by `max_scan_pages`),
`fields=` (comma-separated result fields to return), `lang=ar`.

`status`, `type`, `nationality`, `sector`, and `activity` accept **friendly
names** (e.g. `status=active`, `sector=Manufacturing`, `activity=restaurant`),
resolved to the registry's internal codes automatically. Discover values with
`/lookups/status`, `/lookups/sector`, `/lookups/activity?q=...`, etc. Raw codes
always work too.

> **Note:** the registry upstream cannot combine `sector` with `status` (that
> pair hangs server-side). When both are supplied, the API runs a fast
> sector-only query and applies the status filter client-side (bounded by
> `max_scan_pages`); the response includes `sector_total`, `scanned`, and
> `has_more` so you can page deeper.

### Examples

```bash
curl 'http://localhost:3000/search?name_en=trading&status=active&per_page=5'
curl 'http://localhost:3000/search?sector=Manufacturing&status=ACTIVE&fields=cr_number,name_en,status'
curl 'http://localhost:3000/search?activity=restaurant&per_page=10'
curl 'http://localhost:3000/lookups/activity?q=warehouse'
curl 'http://localhost:3000/company/106966?branch=1&raw=1'
curl 'http://localhost:3000/search?name_ar=%D8%AA%D8%AC%D8%A7%D8%B1%D8%A9&lang=ar'
```

### Activity (ISIC4) coverage

`activity=<name>` resolves through the **registry's own live activity search**
(`POST /api/Activity/SearchActivityAdvancedSearch`) — the same endpoint the
official site's activity picker uses — so a term like `restaurant` resolves to
the registry's real restaurant ISIC4 codes and returns the same precise set the
official site shows. Results are cached per keyword. Raw ISIC4 codes
(`activity=521-1`) always pass through unchanged.

If the live endpoint is unreachable, or returns no match for a lay term the
registry doesn't index (e.g. `cafe`), resolution falls back to a bundled offline
table (`src/data/isic4.json`, built by `node scripts/harvest-isic4.mjs`) plus a
**synonym map** (`ALIASES` in `src/activities.ts`) that maps everyday words to
ISIC4 phrasing (`cafe` → "Food and beverage service", `it`/`software` →
"Computer programming", `salon` → "Hairdressing and beauty"). The
`/lookups/activity?q=<term>` response reports which path served it via a
`source` field (`live` or `offline_fallback`).

## Run locally

```bash
cd server
npm install
npm run dev          # http://localhost:3000 (auto-reload)
# or: npm run build && npm start
```

## Auth (optional)

Set `SIJILAT_API_KEY` to require an `x-api-key` **header** on all endpoints
except `/` and `/health` (the key is header-only — never a query parameter — so
it can't leak into logs or URLs; comparison is constant-time). Leave it unset to
run open. See `.env.example`.

```bash
SIJILAT_API_KEY=$(openssl rand -hex 24) npm start
curl -H "x-api-key: <key>" 'http://localhost:3000/search?cr=21'
```

## Deploy

**Vercel** (from `server/`):
```bash
npm i -g vercel
vercel            # set Project Root = server/ ; add SIJILAT_API_KEY env var
```

**Docker / Fly / Render / Railway**:
```bash
docker build -t sijilat-api .
docker run -p 3000:3000 -e SIJILAT_API_KEY=... sijilat-api
```
(Fly: `fly launch` picks up the Dockerfile; set the secret with `fly secrets set SIJILAT_API_KEY=...`.)

## MCP server (business search + phone numbers)

An [MCP](https://modelcontextprotocol.io) server that lets an agent search the
registry and pull phone numbers. The tools live in `src/mcp-server.ts` and are
served two ways: over HTTP at **`/mcp`** on the deployed API (stateless
Streamable HTTP), and over stdio by `src/mcp.ts` for local use.

| Tool | What it does |
|---|---|
| `search_businesses` | Filter by name, Arabic name, activity (ISIC4 code or keyword), municipality, block, company type, CR number, status (default `ACTIVE`). Paged. |
| `get_business_contacts` | One CR/branch: business phone, mobile, fax, email, website, address, plus `owner_contact`. |
| `find_business_phones` | Search plus contacts for each match in one call (max 25 per page). |
| `search_activities` | Keyword → ISIC4 codes (single words match best). |

`owner_contact` comes from the CR's latest **GET LICENSE** application
(amend code `0303`). It's usually the owner's own number, and it often differs
from the commercial-address number. It's `null` for CRs that never filed one,
which is typical of old, low-numbered CRs. Phones are normalised to E.164.
CPR and passport numbers are never returned.

### Install

**Claude Code: one line, hosted server + skill.**

```bash
curl -fsSL https://raw.githubusercontent.com/masterde/sijilat/HEAD/server/mcp/install.sh | bash
```

This registers the hosted server (`https://sijilat-api.vercel.app/mcp`, user
scope) and installs the **`sijilat` skill** to `~/.claude/skills/sijilat/`. The
skill is the playbook: resolve activity codes first, page 25 at a time,
de-duplicate branches, business vs owner numbers, and when to switch to the
bulk exporter. Re-run the command to update. Flags: `--no-skill`, `--no-claude`.

To add just the server without the skill:

```bash
claude mcp add --transport http sijilat https://sijilat-api.vercel.app/mcp
```

The server also sends a short version of that guidance as MCP `instructions`
when a client connects, so agents get the basics even without the skill.

**Claude Desktop / claude.ai.** Add a custom connector with the URL
`https://sijilat-api.vercel.app/mcp`. Other clients: a Streamable HTTP server
at the same URL.

The endpoint is **open** (like the rest of the API). To lock it down, set
`SIJILAT_API_KEY` on Vercel; clients then send the key as a header:
`claude mcp add ... --header "x-api-key: <key>"`.

**Local (stdio), for offline or self-hosted use.** Needs Node 20+. Add
`--local` to the one-liner: it downloads one self-contained file to
`~/.local/share/sijilat-mcp/` and registers that instead, plus the skill. Add
`--desktop` as well to write the local server into Claude Desktop's config
(a backup is made first).

```bash
curl -fsSL https://raw.githubusercontent.com/masterde/sijilat/HEAD/server/mcp/install.sh | bash -s -- --local
```

For Claude Desktop you can also download
[`mcp/sijilat.mcpb`](https://github.com/masterde/sijilat/raw/HEAD/server/mcp/sijilat.mcpb)
and double-click it. Desktop runs it with its built-in Node.

**Any other MCP client (local).** Configure a stdio server with command `node` and
argument `<path>/sijilat-mcp.mjs`. The file has no dependencies, so you can
copy it anywhere.

There's nothing to configure: the registry uses public auth, so no API key is
needed.

### Upstream limits (protecting the registry, and this server's IP)

On 2026-10-31 one client's burst through the hosted server (~900 registry
calls in 3 minutes) got Vercel's IP blocked by the registry (HTTP 403 on every
call, for every user). The client now guards all registry traffic
(`src/ratelimit.ts`):

| Guard | Default | Env var |
|---|---|---|
| Request spacing | 4 calls/s | `SIJILAT_UPSTREAM_PER_SECOND` |
| Rolling budget | 120 calls/min | `SIJILAT_UPSTREAM_PER_MINUTE` |
| Max wait for budget before failing | 5 s (hosted), 60 s (local MCP), unlimited (exporter) | `SIJILAT_UPSTREAM_MAX_WAIT_MS` |
| Breaker cooldown after a 403 | 15 min | `SIJILAT_BLOCK_COOLDOWN_S` |

- **A 403 opens a circuit breaker.** For the cooldown, every call fails fast
  without touching the registry (HTTP API: `503 registry_blocked` with
  `Retry-After`; MCP: a clear "do not retry in a loop" error). Afterwards one
  probe call decides whether to close it.
- **Budget exhausted** → `429 upstream_budget` with `Retry-After`.
- `find_business_phones` stops a page at the first block and returns the rows
  it already has, with `stopped_early`. The exporter stops the run (exit 3)
  without writing error rows, so re-running resumes.
- **`/health` makes a real registry call**, a 1-row search cached for 30 s. It
  reports `reachable`, `unreachable` or `blocked`, plus breaker state and
  budget usage. (It used to read cached lookups, which is why it said
  "reachable" during the block.)

The thresholds are guesses: about 300 calls/min sustained got blocked, while
about 420 calls in 45 s from one machine did not. The guards are **per
process**. On Vercel that means per instance; Fluid Compute reuses instances,
so one bursting client mostly hits the same one, but it isn't a global
guarantee. If blocks recur, move the budget and breaker into shared state
(e.g. Redis).

### Releasing a new version

`mcp/sijilat-mcp.mjs` and `mcp/sijilat.mcpb` are build outputs that are
committed so the URLs above work. Pushing to `feat/nodejs-api` deploys the
hosted server automatically (the Vercel project is connected to the repo).
After changing anything under `src/`:

```bash
npm run bundle:mcp    # rebuilds both; bump "version" in package.json first
```

For local development without bundling, use `npm run mcp` (it runs via tsx).
When tool behaviour changes, update both `MCP_INSTRUCTIONS` in
`src/mcp-server.ts` and the skill at `mcp/skill/sijilat/SKILL.md`.

### Bulk export (thousands of businesses)

An MCP call can't enrich thousands of rows, so use the resumable exporter. It
writes `<out>.jsonl` as it goes (re-run the same command to resume or retry
errors), then `<out>.csv` (UTF-8 BOM, Excel-safe):

```bash
npx tsx scripts/export-contacts.mts --activity 5610-1 --block 264 --out exports/5610-1_block-264
# --status ACTIVE ('' = any)  --municipality ..  --name ..  --limit N  --concurrency 4  --no-owner  --per-minute 120
```

Each business costs 3 registry calls (1 with `--no-owner`), paced to the
120 calls/min budget: about 40 businesses a minute. Block 264 (140 branches)
takes about 3.5 min, and all active `5610-1` businesses (about 7.3k) about 3
hours (or about 1 hour with `--no-owner`). Raise `--per-minute` only with care
(see *Upstream limits*). `exports/` is git-ignored because it holds personal
phone numbers.

## How it works

The registry authenticates every visitor with a public OAuth *password* grant
whose credentials are constants in the site's own JavaScript
(`HMAC-SHA256("sijilat_test")`), and encrypts detail/lookup request bodies with
CryptoJS-AES (`"MySecretKey"`, OpenSSL salted / MD5-KDF / AES-256-CBC). Both are
reproduced in `src/crypto.ts` with Node's built-in `crypto`. The bearer token
(~30 min) and the lookup code tables are cached per process. Data is sourced
from `sijilat.bh`, operated by the Bahrain Ministry of Industry & Commerce, for
informational use.

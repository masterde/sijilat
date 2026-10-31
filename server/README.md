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

**Hosted (recommended): nothing to download.**

```bash
claude mcp add --transport http sijilat https://sijilat-api.vercel.app/mcp
```

For Claude Desktop or claude.ai, add a custom connector with the URL
`https://sijilat-api.vercel.app/mcp`. For any other client, configure a
Streamable HTTP server at the same URL.

The endpoint is **open** (like the rest of the API). To lock it down, set
`SIJILAT_API_KEY` on Vercel; clients then send the key as a header:
`claude mcp add ... --header "x-api-key: <key>"`.

**Local (stdio), for offline or self-hosted use.** Needs Node 20+.
The one-liner downloads one self-contained file to `~/.local/share/sijilat-mcp/`
and registers it with Claude Code; re-run it to update.

```bash
curl -fsSL https://raw.githubusercontent.com/masterde/sijilat/HEAD/server/mcp/install.sh | bash
```

Add `-s -- --desktop` to also write it into Claude Desktop's config (a backup
is made first), or `-s -- --no-claude` to only download it.

For Claude Desktop you can also download
[`mcp/sijilat.mcpb`](https://github.com/masterde/sijilat/raw/HEAD/server/mcp/sijilat.mcpb)
and double-click it. Desktop runs it with its built-in Node.

**Any other MCP client (local).** Configure a stdio server with command `node` and
argument `<path>/sijilat-mcp.mjs`. The file has no dependencies, so you can
copy it anywhere.

There's nothing to configure: the registry uses public auth, so no API key is
needed.

### Releasing a new version

`mcp/sijilat-mcp.mjs` and `mcp/sijilat.mcpb` are build outputs that are
committed so the URLs above work. After changing anything under `src/`:

```bash
npm run bundle:mcp    # rebuilds both; bump "version" in package.json first
```

For local development without bundling, use `npm run mcp` (it runs via tsx).

### Bulk export (thousands of businesses)

An MCP call can't enrich thousands of rows, so use the resumable exporter. It
writes `<out>.jsonl` as it goes (re-run the same command to resume or retry
errors), then `<out>.csv` (UTF-8 BOM, Excel-safe):

```bash
npx tsx scripts/export-contacts.mts --activity 5610-1 --block 264 --out exports/5610-1_block-264
# --status ACTIVE ('' = any)  --municipality ..  --name ..  --limit N  --concurrency 4  --no-owner
```

Each business costs 3 registry calls (1 with `--no-owner`). Block 264 (140
branches) takes about 45 s. All active `5610-1` businesses (about 7.3k) would
take roughly an hour or more. `exports/` is git-ignored because it holds
personal phone numbers.

## How it works

The registry authenticates every visitor with a public OAuth *password* grant
whose credentials are constants in the site's own JavaScript
(`HMAC-SHA256("sijilat_test")`), and encrypts detail/lookup request bodies with
CryptoJS-AES (`"MySecretKey"`, OpenSSL salted / MD5-KDF / AES-256-CBC). Both are
reproduced in `src/crypto.ts` with Node's built-in `crypto`. The bearer token
(~30 min) and the lookup code tables are cached per process. Data is sourced
from `sijilat.bh`, operated by the Bahrain Ministry of Industry & Commerce, for
informational use.

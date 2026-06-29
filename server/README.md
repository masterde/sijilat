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

`activity=<name>` resolves against a bundled table (`src/data/isic4.json`,
built by `node scripts/harvest-isic4.mjs`) covering common activities; raw ISIC4
codes (`activity=521-1`) always work. Re-run the harvester to expand coverage.

Matching has three layers, so everyday search terms resolve even though the
registry uses formal **ISIC4** names: substring (`warehouse` → "Warehousing"),
light stemming (`trade` → "Trading"), and a **synonym map** for lay terms the
standard doesn't use — e.g. `restaurant`/`cafe` → "Food and beverage service
activities" + "Catering", `it`/`software` → "Computer programming", `salon` →
"Hairdressing and beauty", `pharmacy` → "Dispensing chemist". Aliases live in
`ALIASES` in `src/activities.ts`. Use `/lookups/activity?q=<term>` to see exactly
which codes a term resolves to.

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

## How it works

The registry authenticates every visitor with a public OAuth *password* grant
whose credentials are constants in the site's own JavaScript
(`HMAC-SHA256("sijilat_test")`), and encrypts detail/lookup request bodies with
CryptoJS-AES (`"MySecretKey"`, OpenSSL salted / MD5-KDF / AES-256-CBC). Both are
reproduced in `src/crypto.ts` with Node's built-in `crypto`. The bearer token
(~30 min) and the lookup code tables are cached per process. Data is sourced
from `sijilat.bh`, operated by the Bahrain Ministry of Industry & Commerce, for
informational use.

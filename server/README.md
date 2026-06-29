# Sijilat API

A small, deployable HTTP API for querying the Kingdom of Bahrain's **Sijilat**
commercial registry (`sijilat.bh`). It wraps the registry's undocumented JSON
API — handling the public token handshake and AES-encrypted detail requests
internally — and exposes clean REST endpoints. No registry account or key is
required (the service mints its own public token).

Built with [Hono](https://hono.dev) + TypeScript. Runs anywhere: local Node,
Docker/Fly/Render/Railway, or Vercel.

## Endpoints

| Method & path | Description |
|---|---|
| `GET /` | API info |
| `GET /health` | Liveness + registry reachability |
| `GET /search` | Search commercial registrations |
| `GET /company/:cr` | Full company profile (`?branch=`, `?raw=1`) |
| `GET /lookups` | All filter code tables |
| `GET /lookups/:table` | One table: `status\|type\|nationality\|sector\|municipality` |

### `GET /search` query parameters

At least one filter is required.

`name_en`, `name_ar`, `cr`, `status`, `type`, `nationality`, `sector`,
`activity`, `partner`, `partner_ar`, `partner_nat`, `partner_cr`, `reg_from`,
`reg_to`, `road`, `block`, `building`, `passport` — plus `limit` (default 25),
`all=1` (page through every match, bounded by `max_scan_pages`, default 20),
and `lang=ar`.

`status`, `type`, `nationality`, and `sector` accept **friendly names** (e.g.
`status=ACTIVE`) which are resolved to the registry's internal codes
automatically. Use `GET /lookups/status` to see all valid values.

### Examples

```bash
curl 'http://localhost:3000/search?name_en=trading&status=ACTIVE&limit=5'
curl 'http://localhost:3000/company/106966?branch=1'
curl 'http://localhost:3000/lookups/status'
curl 'http://localhost:3000/search?name_ar=%D8%AA%D8%AC%D8%A7%D8%B1%D8%A9&lang=ar'
```

## Run locally

```bash
cd server
npm install
npm run dev          # http://localhost:3000 (auto-reload)
# or: npm run build && npm start
```

## Auth (optional)

Set `SIJILAT_API_KEY` to require an `x-api-key` header (or `?api_key=`) on all
endpoints except `/` and `/health`. Leave it unset to run open. See `.env.example`.

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

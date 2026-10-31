# Sijilat API — Architecture & Reverse-Engineering Notes

This document captures **how the Sijilat API works internally**, the
reverse-engineered registry contract it wraps, and the design decisions behind
the current implementation. It is the reference for anyone (human or agent)
continuing development.

For user-facing usage, see `README.md`. For the machine-readable contract, see
`openapi.json` (served at `/openapi.json`, rendered at `/docs`).

---

## 1. What this is

A small, deploy-anywhere **Hono + TypeScript** HTTP API that wraps the Kingdom
of Bahrain's **Sijilat** commercial registry (`sijilat.bh`). The registry has no
official public API — it has an undocumented JSON backend at
`https://api.sijilat.bh/api/` that the public website calls. This service
reproduces that backend's auth + encryption and exposes clean REST endpoints.

- **Runtime:** Node (`src/server.ts`) or Vercel (zero-config Hono preset; the
  default export in `src/app.ts` is the function entry).
- **Deployed:** `https://sijilat-api.vercel.app` (Vercel project `sijilat-api`,
  scope `bakers-projects-054fcfc5`). Currently **open** (no API key set).
- **Branch:** `feat/nodejs-api`. The Go CLI lives at the repo root on `main`.

---

## 2. The reverse-engineered registry contract

Everything below was recovered by inspecting the site's JavaScript and capturing
live browser requests. None of it is officially documented.

### 2.1 Authentication — OAuth2 password grant with public constants

`POST https://api.sijilat.bh/token` (form-urlencoded):

```
username=sijilat
password=<HMAC-SHA256(appName, key) hex>
grant_type=password
```

The password is **not a secret** — it's computed in the site's own JS from
public constants: `HMAC-SHA256` of app name `"sijilat_test"` with key
`"UHxNtYMRYwvfpO1dS5pWLKL0M2DgOj40EbN4SoBWgfc"`. Reproduced in
`src/crypto.ts:tokenPassword()`. Returns a bearer JWT (~30 min TTL), cached
per-process in `SijilatClient` (`getToken()`, with in-flight de-duplication).

> **Security note:** the HMAC key/app name are public app-level constants and are
> fine in source. The **minted `access_token`** is a session secret and must
> never be persisted to disk, artifacts, or git.

### 2.2 Request encryption — CryptoJS AES (OpenSSL "salted")

Some endpoints take an **AES-encrypted** body; others take plain JSON. The
encryption is CryptoJS's default `AES.encrypt(plaintext, "MySecretKey")`:

- OpenSSL "salted" envelope: `"Salted__"` + 8-byte random salt + ciphertext,
  base64-encoded (recognisable by the `U2FsdGVkX1...` prefix).
- Key/IV via **EVP_BytesToKey** (MD5 KDF) over passphrase `"MySecretKey"` + salt.
- **AES-256-CBC**, PKCS#7 padding.

Reproduced with Node's built-in `crypto` in `src/crypto.ts:encryptBody()`
(`evpBytesToKey()` is the KDF). The same scheme **decrypts** too — useful for
reverse-engineering captured request bodies (see §4).

Content type for encrypted bodies: `application/encrypted+json; charset=utf-8`.

### 2.3 Response envelope

All `/api/*` endpoints return:

```json
{ "Status_Code": "200", "Status_Message": "Success", "jsonData": { ... } }
```

`SijilatClient.post()` checks `Status_Code` and returns `jsonData`. Responses are
**plain JSON** (not encrypted), even when the request body was encrypted.

### 2.4 Endpoints in use

| Purpose | Path | Body | Encrypted? | Key response fields |
|---|---|---|---|---|
| CR search (paged) | `CRdetails/AdvanceSearchCR_Paging` | filters + paging | No | `Total_Records`, `CR_list[]` |
| Company detail | `CRdetails/CompleteCRDetails` | `CR_NO`, `BRANCH_NO` | **Yes** | full profile |
| Lookup tables | `Common/AdvanceSrch_lookup` | lang flags | **Yes** | `CR_Status_lst`, `Company_Type_lst`, `Nationality_lst`, `Sectorlist`, `Municipality_lst` |
| **Activity search** | `Activity/SearchActivityAdvancedSearch` | keyword in `ISIC4_NM` | **Yes** | `RSLTDT[]` of `{ISIC4_CD, ISIC4_NM, ISIC4_LNM, ISIC4_ANM, ...}` |
| Applications per CR | `Application/StatusEnquiry` | `CR_NO` + 25-year date window | **Yes** | array of `{APP_NO, APP_YEAR, APP_SEQ, AMEND_CD, BRANCH_NO, ...}` |
| Amendment detail | `Application/AmendApplicaitonHistory` (sic) | a full StatusEnquiry row + page params | **Yes** | per-type sections, e.g. `amend_ObtainLic` |

**Status code for ACTIVE** companies is `3103` (referenced when filtering).

### 2.5 The activity-search endpoint (recovered 2026-06-29)

The public activity picker (`/public-activity-search/activity-search-2.aspx`) is
a **Vite + React** app the production page loads from `http://localhost:5173`
(a dev-server reference left in production). The endpoint name therefore appears
in **no file the site actually serves** — it could only be recovered by capturing
the live XHR in a browser. The captured encrypted body was then decrypted with
the `"MySecretKey"` scheme to recover the exact request shape:

```jsonc
// POST Activity/SearchActivityAdvancedSearch  (AES-encrypted)
{
  "ISIC4_CD": "",            // exact code (optional)
  "ISIC4_NM": "restaurant",  // <-- keyword goes here; registry matches name + synonyms
  "ISIC4_DETL": "",
  "VTUAL_ADDR_YN": "", "AME_YN": "", "FORGN_YN": "", "GCC_YN": "",
  "BAH_51_RATIO_YN": "", "ICR_YN": "", "CCR_YN": "", "SING_YN": "",
  "EURO1_YN": "", "INCLU_BAH_YN": "",   // advanced filters, all optional
  "cult_lang": "EN", "CULT_LANG": "EN", "MENU_TYPE": "A",
  "SESSION_ID": ""           // sent EMPTY — bearer token is the auth, no session needed
}
```

Response: `jsonData.RSLTDT[]`, each `{ISIC4_CD, ISIC4_NM, ISIC4_LNM (long EN),
ISIC4_ANM (Arabic), ISIC4_LEV, ISIC4_ORI_CD, ...}`. This is the registry's own
matcher, so `restaurant` returns exactly the codes the official site shows
(`5610-3`, `5610-4`) — precise, not a broad guess.

### 2.6 Owner contact via the GET LICENSE amendment (recovered 2026-10-31)

The commercial address in `CompleteCRDetails` often carries a shop/office
number. The owner's own phone is usually on the CR's **GET LICENSE**
application (amend code `0303`). The public CR page links each amendment to
`/amendment-information/amendment-information.aspx`, whose script calls
`Application/AmendApplicaitonHistory` (upstream misspelling) with the amendment
row merged with its `Application/StatusEnquiry` row.

- **Pass `APP_YEAR` + `APP_SEQ`.** Without them the upstream still returns
  `200` but fills the type-specific sections from an unrelated application. The
  phone would then belong to a different business. Always take the row from
  `StatusEnquiry` (`SijilatClient.applications()`), never build it from
  `amendhistory` alone.
- Phones live at `amend_ObtainLic.Proposed_Commercial_Address_New`
  (`NAT_PHONE_BIS_NM`, `NAT_MOBILE_NM`, `CR_EMAIL`). `amendInformation.crWithoutLic.owner_Info`
  is the fallback.
- `commercial_Name_Current` there is the name **at filing time** and may differ
  from today's name. That's expected, not a mismatch.
- Responses include applicant/partner **CPR and passport numbers**. Never
  surface or persist them (`licenseContact()` extracts only phone/fax/email).
- Old, low-numbered CRs predate online licensing and have no `0303` row.

---

## 3. Service architecture

```
src/
  crypto.ts      token password (HMAC), encryptBody (CryptoJS AES), evpBytesToKey
  sijilat.ts     SijilatClient: token cache, search/searchAll, detail, lookups,
                 searchActivitiesLive, filter name->code resolution, RateLimiter use
  activities.ts  OFFLINE fallback: bundled ISIC4 table + synonym ALIASES + stemming
  ratelimit.ts   adaptive RateLimiter (concurrency + 429 backoff)
  detail.ts      parseDetail(): shapes CompleteCRDetails into a clean profile
  app.ts         Hono routes, API-key middleware, fields projection, pagination,
                 sector+status fallback, /docs + /openapi.json
  openapi.ts     OpenAPI 3.1 spec object
  contacts.ts    contact shaping + E.164 phone normalisation (MCP + exporter)
  mcp.ts         stdio MCP server: search_businesses, get_business_contacts,
                 find_business_phones, search_activities
  server.ts      Node entry (@hono/node-server)
  data/isic4.json  141 harvested ISIC4 codes (offline fallback only)
scripts/
  harvest-isic4.mjs  rebuilds data/isic4.json (offline fallback table)
  dump-openapi.mjs   writes openapi.json from the built spec
  export-contacts.mts  resumable bulk contact export (JSONL + CSV)
```

### Request flow for `/search?activity=<name>&status=<name>`

1. `app.ts` parses query → `SearchFilters`.
2. `SijilatClient.search()` → `resolveFilters()`:
   - **activity** → `resolveActivityCodes()`: codes pass through; each name is
     resolved via **`searchActivitiesLive()`** (live endpoint, cached). If live
     is unreachable or returns nothing, falls back to the offline
     `resolveActivityNames()` (table + `ALIASES`).
   - **status/type/nationality/sector/municipality** → `resolveCodes()` against
     the cached `lookups()` tables (only fetched if a name is present).
3. `buildSearchBody()` maps resolved codes into the `AdvanceSearchCR_Paging`
   body (activity codes go into `ISIC4_CD`, quoted+comma-joined = OR).
4. Results mapped via `rowToCompany()`; `app.ts` applies `fields=` projection
   and pagination metadata.

### Key design decisions / gotchas

- **sector + status cannot be combined upstream.** `AdvanceSearchCR_Paging`
  hangs (>25s) when both `FIRST_LEV` (sector) and status are set, regardless of
  result size. `app.ts:sectorStatusSearch()` works around it: fast sector-only
  query + **client-side** status filtering, bounded by `max_scan_pages`. Response
  includes `sector_total`, `scanned`, `has_more`.
- **Activity resolution is live-first, offline-fallback.** The registry's own
  matcher is authoritative and precise; the bundled table/aliases only cover the
  rare lay term the registry doesn't index (e.g. `cafe`). `/lookups/activity`
  reports `source: "live" | "offline_fallback"`.
- **Every upstream fetch has `AbortSignal.timeout(25s)`** — global `fetch` has no
  default timeout and a stalled connection would hang the serverless function.
- **RateLimiter** (`ratelimit.ts`) caps concurrency and backs off on 429s.
- **API key (optional):** when `SIJILAT_API_KEY` is set, an `x-api-key` **header**
  is required (constant-time compare via `timingSafeEqual`; never a query param,
  so it can't leak into logs/URLs). `/`, `/health`, `/docs`, `/openapi.json` stay
  open. Currently unset in production (the API is open by choice).

### Security invariants (must hold)

- Never persist minted `access_token`s, session cookies, or `SESSION_ID` values.
- The HMAC key, app name, and AES passphrase are **public** app constants — OK in
  source. Real secrets (an `SIJILAT_API_KEY`, if set) are env-only.
- API-key check stays header-only + constant-time.

---

## 4. How to reverse-engineer another registry endpoint

When the site calls an endpoint this API doesn't wrap yet:

1. **Capture the request.** Open the relevant page in Chrome DevTools → Console,
   paste the fetch/XHR-wrapping snippet (logs any call to `api.sijilat.bh` with
   URL + body + response), perform the action, copy the logged block. (The
   `claude-in-chrome` browser harness can also drive this.)
2. **Decrypt the body** if it's `U2FsdGVkX1...` (encrypted). Reuse the
   `"MySecretKey"` AES scheme — see `src/crypto.ts` and the decrypt snippet
   pattern (EVP_BytesToKey MD5 KDF → AES-256-CBC). This recovers the exact field
   names.
3. **Replay it** from a small script that mints a token via `crypto.ts` and POSTs
   the (re-encrypted) body, to confirm the response shape before wiring it in.
4. **Wire it** into `SijilatClient` as a method, expose a route in `app.ts`, add
   it to `openapi.ts`, and document it here + in `README.md`.

> Static analysis alone won't always work: the activity endpoint lived only in an
> un-served dev bundle. A live browser capture was the only way to get it.

---

## 5. Deployment

```bash
cd /Users/baker/Playground/Sijilat-CLI            # repo root (NOT server/)
vercel --prod --yes --scope bakers-projects-054fcfc5
```

The `sijilat-api` Vercel project has **Root Directory = `server`**, so deploy
from the repo root and Vercel builds `server/`. After code/spec changes:
`npm run build && node scripts/dump-openapi.mjs` before committing.

---

## 6. Status of subsystems

| Subsystem | State |
|---|---|
| Token auth + caching | done |
| AES encrypt/decrypt | done |
| CR search (paged, fields, all) | done |
| Company detail (`/company/:cr`, `raw`) | done |
| Lookups (status/type/nationality/sector/municipality) | done |
| Case-insensitive, comma-separable name→code resolution | done |
| **Live activity search** (precise ISIC4) | done |
| Offline activity fallback (table + aliases) | done |
| sector+status client-side workaround | done |
| Address filters (flat/road/block/building/municipality) | done |
| OpenAPI 3.1 + `/docs` | done |
| Rate limiting + per-request timeouts | done |
| Optional header API key | done |
| MCP server (search + phones, owner contact) | done |
| Bulk contact export (resumable CSV) | done (script; no HTTP route yet) |
| Persistent caching / response Cache-Control | not done |
| Tests | none yet |

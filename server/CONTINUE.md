# Continuation Prompt — Sijilat API

Paste the block below into a new Claude Code session (run from
`/Users/baker/Playground/Sijilat-CLI`) to keep improving the API.

---

I'm continuing work on the **Sijilat API** — a Hono + TypeScript service in
`server/` that wraps Bahrain's Sijilat commercial registry
(`api.sijilat.bh`), deployed at `https://sijilat-api.vercel.app` on branch
`feat/nodejs-api`. The Go CLI at the repo root (`main`) is separate; don't touch it.

**Read `server/ARCHITECTURE.md` first** — it documents the reverse-engineered
registry contract (token HMAC, CryptoJS-AES bodies, endpoints), the request flow,
the live activity-search integration, and the key gotchas (esp. the
sector+status upstream hang and the live-first/offline-fallback activity
resolution). Then skim `server/README.md` and `server/src/{app,sijilat,crypto,activities}.ts`.

**Current state:** search (paged, `fields=`, `all=1`), `/company/:cr`, `/lookups/*`,
case-insensitive name→code resolution, **live ISIC4 activity search** (precise),
sector+status client-side workaround, address filters, OpenAPI 3.1 + `/docs`,
rate limiting, optional header API key. The API is currently **open** (no key set).

**Hard constraints (do not violate):**
- Never persist minted `access_token`s, session cookies, or `SESSION_ID` to
  source/artifacts/git. The HMAC key + AES passphrase `"MySecretKey"` are public
  app constants and are fine in source.
- API-key check stays header-only + constant-time.
- Deploy from the **repo root** (not `server/`): the Vercel project's Root
  Directory is `server`. Command:
  `vercel --prod --yes --scope bakers-projects-054fcfc5`.
- Before committing spec/code changes: `cd server && npm run build && node scripts/dump-openapi.mjs`.

**What I want to work on next (let's pick / I'll choose):**

1. **Lead-generation layer** (the original end goal — was deferred). Build *on top
   of* the search API: a `/leads` flow that takes a filter (e.g. active companies
   in an activity/sector), fans out to `/company/:cr` for contact enrichment
   (phone/mobile/email/website/address live only in `CompleteCRDetails`), and
   returns/streams a deduped, structured lead list. Consider CSV export and
   bounded concurrency. This is the big one.

2. **Caching & performance.** Add short-TTL response caching + sensible
   `Cache-Control` on read endpoints; persist the lookup tables across cold
   starts; measure and reduce the activity-resolution round-trips.

3. **Tests.** There are none. Add a small suite (Vitest) covering crypto
   (token + encrypt/decrypt round-trip), filter resolution, the sector+status
   fallback logic, and route contracts (mock the upstream).

4. **More registry endpoints.** Reverse-engineer + wrap anything still missing
   (e.g. activity *detail* `activity-details-new.aspx?act_cd=`, partner/owner
   graph, document templates). Use the §4 recipe in ARCHITECTURE.md; the
   `claude-in-chrome` harness can capture live requests.

5. **Robustness.** Typed error taxonomy, retry-with-backoff on transient 5xx,
   richer `/health`, request validation with friendly 4xx messages.

Start by reading ARCHITECTURE.md, confirm the live API is healthy
(`curl https://sijilat-api.vercel.app/health`), then propose a short plan for
[**pick a number above, or "lead-gen layer"**] before implementing.

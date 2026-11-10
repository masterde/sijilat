// Sijilat registry client: token mint + cache, search, AES-encrypted detail,
// lookup tables, and name->code filter resolution. Ported from the Go CLI.

import { encryptBody, tokenPassword, TOKEN_USERNAME } from "./crypto.js";
import { RateLimiter, RegistryBlockedError, type LimitOptions } from "./ratelimit.js";

export { RegistryBlockedError, UpstreamBudgetError, isUpstreamStop } from "./ratelimit.js";
import { resolveActivityNames } from "./activities.js";

const DEFAULT_BASE_URL = "https://api.sijilat.bh/api/";
const USER_AGENT = "sijilat-api (+https://github.com/mvanhorn/printing-press-library)";
// Per-request upstream timeout — global fetch has no default, so a stalled
// registry connection would otherwise hang the request forever.
const REQUEST_TIMEOUT_MS = 25_000;

export interface SearchFilters {
  nameEn?: string;
  nameAr?: string;
  crNumber?: string;
  status?: string;
  type?: string;
  municipality?: string;
  block?: string;
  nationality?: string;
  sector?: string;
  activity?: string;
  partnerEn?: string;
  partnerAr?: string;
  partnerNat?: string;
  partnerCr?: string;
  regFrom?: string;
  regTo?: string;
  road?: string;
  flat?: string;
  building?: string;
  passport?: string;
  regType?: string;
}

export interface Company {
  cr_number: string;
  branch: string;
  name_en: string;
  name_ar: string;
  company_type: string;
  status: string;
  registered_on: string;
  expires_on: string;
  activities: string[];
  sector: string;
}

export interface CodeName {
  code: string;
  name: string;
  flag?: string;
}

export interface LookupTables {
  status: CodeName[];
  types: CodeName[];
  nationalities: CodeName[];
  sectors: CodeName[];
  municipalities: CodeName[];
}

/** Amend code of the "GET LICENSE" application type. */
export const GET_LICENSE_AMEND_CD = "0303";

/** One row of Application/StatusEnquiry (subset; upstream sends ~30 fields). */
export interface ApplicationRow {
  APP_NO?: string;
  APP_YEAR?: string;
  APP_SEQ?: string;
  AMEND_CD?: string;
  CR_NO?: string;
  BRANCH_NO?: string;
  RECEV_DATE?: string;
  APP_TYP_LNM?: string;
  [k: string]: unknown;
}

export interface LicenseContact {
  application_no: string;
  filed_on: string;
  branch: string;
  phone: string;
  mobile: string;
  fax: string;
  email: string;
}

/** Thrown when the API returns HTTP 429. */
export class RateLimitError extends Error {
  constructor(public url: string) {
    super(`rate limited: HTTP 429 for ${url}`);
    this.name = "RateLimitError";
  }
}

export class SijilatError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "SijilatError";
  }
}

export class SijilatClient {
  readonly baseUrl: string;
  readonly tokenUrl: string;
  private token: string | null = null;
  private tokenExpiry = 0;
  private lookupsCache: LookupTables | null = null;
  private inflightToken: Promise<string> | null = null;
  // Cache live activity-search results per lowercased keyword (process-lifetime).
  private activityCache = new Map<string, CodeName[]>();
  private readonly limiter: RateLimiter;

  /** `limits` overrides the env/default upstream limits (see ratelimit.ts). */
  constructor(baseUrl = process.env.SIJILAT_BASE_URL || DEFAULT_BASE_URL, limits: Partial<LimitOptions> = {}) {
    this.limiter = new RateLimiter(limits);
    if (!baseUrl.endsWith("/")) baseUrl += "/";
    this.baseUrl = baseUrl;
    const u = new URL(baseUrl);
    this.tokenUrl = `${u.protocol}//${u.host}/token`;
  }

  /** Returns a valid bearer token, minting + caching one (~30 min) as needed. */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;
    if (this.inflightToken) return this.inflightToken;
    this.inflightToken = (async () => {
      const body = new URLSearchParams({
        username: TOKEN_USERNAME,
        password: tokenPassword(),
        grant_type: "password",
      });
      await this.limiter.acquire();
      const resp = await fetch(this.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (resp.status === 429) {
        this.limiter.onRateLimit();
        throw new RateLimitError(this.tokenUrl);
      }
      if (resp.status === 403) throw this.blocked();
      if (!resp.ok) throw new SijilatError(`token endpoint returned HTTP ${resp.status}`, resp.status);
      this.limiter.onSuccess();
      const data = (await resp.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) throw new SijilatError("token response missing access_token");
      this.token = data.access_token;
      const ttl = data.expires_in && data.expires_in > 0 ? data.expires_in : 1799;
      this.tokenExpiry = Date.now() + (ttl - 60) * 1000;
      return this.token;
    })();
    try {
      return await this.inflightToken;
    } finally {
      this.inflightToken = null;
    }
  }

  /** POSTs a JSON body (optionally AES-encrypted) and returns the jsonData payload. */
  private async post(path: string, body: unknown, encrypted: boolean): Promise<unknown> {
    const tok = await this.getToken();
    const raw = JSON.stringify(body);
    const payload = encrypted ? encryptBody(raw) : raw;
    const contentType = encrypted
      ? "application/encrypted+json; charset=utf-8"
      : "application/json; charset=utf-8";

    await this.limiter.acquire();
    const resp = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        "content-type": contentType,
        accept: "*/*",
        authorization: `Bearer ${tok}`,
        "user-agent": USER_AGENT,
      },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 429) {
      this.limiter.onRateLimit();
      throw new RateLimitError(this.baseUrl + path);
    }
    if (resp.status === 403) throw this.blocked();
    if (!resp.ok) throw new SijilatError(`POST ${path} returned HTTP ${resp.status}`, resp.status);
    this.limiter.onSuccess();
    const env = (await resp.json()) as {
      Status_Code?: string;
      Status_Message?: unknown;
      jsonData?: unknown;
    };
    if (env.Status_Code && env.Status_Code !== "200") {
      const msg =
        typeof env.Status_Message === "string" ? env.Status_Message : JSON.stringify(env.Status_Message);
      throw new SijilatError(`API error on ${path}: status ${env.Status_Code}: ${msg}`, Number(env.Status_Code));
    }
    return env.jsonData;
  }

  /** 403 = the registry is refusing this IP: open the breaker and fail fast. */
  private blocked(): RegistryBlockedError {
    this.limiter.trip();
    return new RegistryBlockedError(this.limiter.opts.cooldownMs);
  }

  /** Breaker state + rolling-minute budget usage, for /health. */
  upstreamStatus() {
    return this.limiter.status();
  }

  /**
   * One real, uncached registry round-trip (a 1-row CR search), for health
   * checks. lookups() is cached per process, so it can't detect a block.
   */
  async ping(): Promise<void> {
    await this.search({ crNumber: "1" }, { perPage: 1 });
  }

  async search(
    filters: SearchFilters,
    opts: { page?: number; perPage?: number; langAr?: boolean } = {},
  ): Promise<{ results: Company[]; total: number }> {
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const perPage = opts.perPage && opts.perPage > 0 ? opts.perPage : 10;
    const resolved = await this.resolveFilters(filters);
    const data = (await this.post(
      "CRdetails/AdvanceSearchCR_Paging",
      buildSearchBody(resolved, page, perPage, !!opts.langAr),
      false,
    )) as { Total_Records?: unknown; CR_list?: unknown[] };
    const total = toInt(data?.Total_Records);
    const rows = Array.isArray(data?.CR_list) ? data!.CR_list! : [];
    return { results: rows.map(rowToCompany), total };
  }

  /** Pages through search up to maxItems (negative = all, bounded by maxScanPages). */
  async searchAll(
    filters: SearchFilters,
    opts: { perPage?: number; maxItems?: number; maxScanPages?: number; langAr?: boolean } = {},
  ): Promise<{ results: Company[]; total: number }> {
    const perPage = opts.perPage ?? 50;
    const maxItems = opts.maxItems ?? 25;
    const maxScanPages = opts.maxScanPages ?? 20;
    const all: Company[] = [];
    let total = 0;
    for (let page = 1; page <= maxScanPages; page++) {
      const { results, total: t } = await this.search(filters, { page, perPage, langAr: opts.langAr });
      total = t;
      all.push(...results);
      if (results.length < perPage) break;
      if (maxItems > 0 && all.length >= maxItems) break;
      if (maxItems === 0) break;
    }
    return { results: maxItems > 0 ? all.slice(0, maxItems) : all, total };
  }

  /** Full company profile (AES-encrypted detail endpoint). */
  async detail(crNumber: string, branch = "1"): Promise<unknown> {
    return this.post(
      "CRdetails/CompleteCRDetails",
      {
        CR_NO: crNumber,
        BRANCH_NO: branch || "1",
        cult_lang: "EN",
        CULT_LANG: "EN",
        CurrentMenuTyp: "A",
        MENU_TYPE: "A",
      },
      true,
    );
  }

  /**
   * All applications filed against a CR (every branch), newest first — the
   * list the public CR page merges into its amendment history. Rows carry the
   * APP_YEAR/APP_SEQ that amendmentDetail() needs. Contains applicant CPR_NO;
   * callers must not surface it.
   */
  async applications(crNumber: string): Promise<ApplicationRow[]> {
    const now = new Date();
    const from = new Date(now);
    from.setFullYear(now.getFullYear() - 25);
    const jd = await this.post(
      "Application/StatusEnquiry",
      {
        START_DATE: ddmmyyyy(from),
        END_DATE: ddmmyyyy(now),
        VCR_YN: null,
        APP_NO: null,
        CR_NO: crNumber,
        STATUS: null,
        CM_TYP_CD: null,
        AMEND_CD: null,
        APPCNT_CPR_NO: null,
        CR_LNM: null,
        CR_ANM: null,
        CPR_NO: null,
        PB_NO: null,
        cult_lang: "EN",
        CULT_LANG: "EN",
        MENU_TYPE: "A",
      },
      true,
    );
    const rows = Array.isArray(jd) ? (jd as ApplicationRow[]) : [];
    return rows.sort((a, b) => (b.APP_NO ?? "").localeCompare(a.APP_NO ?? ""));
  }

  /**
   * Full record of one amendment application (the site's amendment-information
   * page). The row MUST come from applications(): without its APP_YEAR/APP_SEQ
   * the upstream silently returns a different application's sections.
   * Note the upstream's own misspelling "Applicaiton".
   */
  async amendmentDetail(row: ApplicationRow): Promise<any> {
    return this.post(
      "Application/AmendApplicaitonHistory",
      {
        ...row,
        amend_cd: row.AMEND_CD,
        app_no: row.APP_NO,
        ref_yn: "Y",
        page_type: "PG",
        cr_no: row.CR_NO,
        branch_no: row.BRANCH_NO || "1",
        URL: "amd_info",
        hidehf: "true",
        cult_lang: "EN",
        CULT_LANG: "EN",
        MENU_TYPE: "A",
      },
      true,
    );
  }

  /**
   * Owner contact captured on the CR's most recent GET LICENSE application
   * (amend code 0303) — usually the owner's own phone/mobile, which the
   * current commercial address often doesn't carry. Prefers the given branch,
   * else any branch of the CR. Returns null when the CR has no such filing.
   */
  async licenseContact(crNumber: string, branch = "1"): Promise<LicenseContact | null> {
    const lic = (await this.applications(crNumber)).filter((r) => r.AMEND_CD === GET_LICENSE_AMEND_CD);
    const row = lic.find((r) => r.BRANCH_NO === branch) ?? lic[0];
    if (!row) return null;
    const jd = await this.amendmentDetail(row);
    const a = jd?.amend_ObtainLic?.Proposed_Commercial_Address_New ?? {};
    const o = jd?.amendInformation?.crWithoutLic?.owner_Info ?? {};
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return {
      application_no: row.APP_NO ?? "",
      filed_on: str(jd?.RECEV_DATE) || row.RECEV_DATE || "",
      branch: row.BRANCH_NO ?? "",
      phone: str(a.NAT_PHONE_BIS_NM) || str(a.CR_PHONE_BIS) || str(o.PHONE),
      mobile: str(a.NAT_MOBILE_NM) || str(a.CR_MOBILE) || str(o.MOBILE),
      fax: str(a.NAT_FAX_NM) || str(a.CR_FAX) || str(o.FAX),
      email: str(a.CR_EMAIL) || str(o.EMAIL),
    };
  }

  async lookups(): Promise<LookupTables> {
    if (this.lookupsCache) return this.lookupsCache;
    const jd = (await this.post(
      "Common/AdvanceSrch_lookup",
      { cult_lang: "EN", CULT_LANG: "EN", CurrentMenuTyp: "A", MENU_TYPE: "A" },
      true,
    )) as Record<string, unknown[]>;
    const lt: LookupTables = {
      status: (jd.CR_Status_lst ?? []).map((s: any) => ({ code: s.STATUS_CD, name: s.STATUS_NM, flag: s.STATUS_FLAG })),
      types: (jd.Company_Type_lst ?? []).map((t: any) => ({ code: t.CM_TYP_CD, name: t.CM_TYP_NM, flag: t.CR_TYPE })),
      nationalities: (jd.Nationality_lst ?? []).map((n: any) => ({ code: n.NAT_CD, name: n.NAT_NM, flag: n.NAT_FLAG })),
      sectors: (jd.Sectorlist ?? []).map((s: any) => ({ code: s.FIRST_LEV, name: s.ISIC4_NM })),
      municipalities: (jd.Municipality_lst ?? []).map((m: any) => ({ code: m.MUNCP_CD, name: m.MUNI_DESC })),
    };
    this.lookupsCache = lt;
    return lt;
  }

  /**
   * Live business-activity (ISIC4) search — the registry's own keyword endpoint
   * used by the public activity picker. Matches names AND synonyms server-side
   * (e.g. "restaurant" -> "Food and beverage service activities - Restaurants"),
   * so it supersedes the bundled offline table. Results cached per keyword.
   */
  async searchActivitiesLive(keyword: string): Promise<CodeName[]> {
    const q = keyword.trim();
    if (!q) return [];
    const key = q.toLowerCase();
    const cached = this.activityCache.get(key);
    if (cached) return cached;
    const jd = (await this.post(
      "Activity/SearchActivityAdvancedSearch",
      activitySearchBody(q),
      true,
    )) as { RSLTDT?: unknown[] };
    const rows = Array.isArray(jd?.RSLTDT) ? jd!.RSLTDT! : [];
    const out: CodeName[] = rows
      .map((r: any) => ({
        code: (r.ISIC4_CD ?? "").trim(),
        name: (r.ISIC4_LNM ?? r.ISIC4_NM ?? "").trim(),
        flag: (r.ISIC4_ANM ?? "").trim() || undefined,
      }))
      .filter((a) => a.code);
    this.activityCache.set(key, out);
    return out;
  }

  /**
   * Resolve a comma-separated activity filter to ISIC4 codes. Codes pass through
   * unchanged; each name is resolved via the live activity endpoint (OR-combined
   * across all its matches). Falls back to the bundled table if the live call
   * fails so search degrades gracefully when the registry is unreachable.
   */
  private async resolveActivityCodes(value?: string): Promise<string> {
    if (!value) return "";
    const out: string[] = [];
    for (let tok of value.split(",")) {
      tok = tok.trim().replace(/'/g, "");
      if (!tok) continue;
      if (/^[0-9]+(-[0-9]+)?$/.test(tok)) {
        out.push(tok);
        continue;
      }
      let hits: CodeName[] = [];
      try {
        hits = await this.searchActivitiesLive(tok);
      } catch {
        // Live endpoint unreachable — handled by the offline fallback below.
      }
      if (hits.length) {
        out.push(...hits.map((h) => h.code));
        continue;
      }
      // Live returned nothing (or failed): fall back to the offline table +
      // synonym aliases, which catch lay terms the registry doesn't index
      // (e.g. "cafe" -> food-and-beverage codes). Last resort: pass the token
      // through so the upstream returns a deterministic (empty) result.
      const fallback = resolveActivityNames(tok);
      out.push(fallback || tok);
    }
    return [...new Set(out)].join(",");
  }

  /**
   * Resolves human-readable filter names to registry codes. Activity names
   * resolve via the live activity endpoint (with offline-table fallback). The
   * status/type/nationality/sector/municipality tables are fetched (and cached)
   * only when at least one of those filters is a name rather than a code.
   */
  private async resolveFilters(f: SearchFilters): Promise<SearchFilters> {
    const out: SearchFilters = { ...f, activity: await this.resolveActivityCodes(f.activity) };
    const needsLookups = [out.status, out.type, out.nationality, out.sector, out.municipality].some(needsResolve);
    if (!needsLookups) return out;
    const lt = await this.lookups();
    out.status = resolveCodes(lt.status, out.status);
    out.type = resolveCodes(lt.types, out.type);
    out.nationality = resolveCodes(lt.nationalities, out.nationality);
    out.sector = resolveCodes(lt.sectors, out.sector);
    out.municipality = resolveCodes(lt.municipalities, out.municipality);
    return out;
  }
}

// --- helpers ---------------------------------------------------------------

function toInt(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function ddmmyyyy(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}

function rowToCompany(r: any): Company {
  return {
    cr_number: r.CR_NO ?? "",
    branch: r.BRANCH_NO ?? "",
    name_en: (r.CR_LNM ?? "").trim(),
    name_ar: (r.CR_ANM ?? "").trim(),
    company_type: r.CM_TYP_DESC ?? "",
    status: r.STATUS ?? "",
    registered_on: r.REG_DATE ?? "",
    expires_on: r.EXPIRE_DATE ?? "",
    activities: splitActivities(r.ACTIVITIES ?? ""),
    sector: r.SECTOR ?? "",
  };
}

function splitActivities(s: string): string[] {
  return s
    .split("~")
    .map((x) => x.trim())
    .filter(Boolean);
}

function quoteCodes(v?: string): string {
  if (!v) return "";
  return v
    .split(",")
    .map((p) => p.trim().replace(/'/g, ""))
    .filter(Boolean)
    .map((p) => `'${p}'`)
    .join(",");
}

/**
 * Request body for Activity/SearchActivityAdvancedSearch. The keyword goes in
 * ISIC4_NM (the registry searches names + synonyms). The many *_YN flags are
 * advanced filters left empty for a plain keyword search. SESSION_ID is sent
 * empty — the bearer token is the auth; no browser session is needed.
 */
function activitySearchBody(keyword: string) {
  return {
    ISIC4_CD: "",
    ISIC4_NM: keyword,
    ISIC4_DETL: "",
    VTUAL_ADDR_YN: "",
    AME_YN: "",
    FORGN_YN: "",
    GCC_YN: "",
    BAH_51_RATIO_YN: "",
    ICR_YN: "",
    CCR_YN: "",
    SING_YN: "",
    EURO1_YN: "",
    INCLU_BAH_YN: "",
    cult_lang: "EN",
    Input_CULT_LANG: "EN",
    CULT_LANG: "EN",
    cultLang: "EN",
    CurrentMenuTyp: "A",
    CurrentMenu_Type: "A",
    MENU_TYPE: "A",
    SESSION_ID: "",
  };
}

function buildSearchBody(f: SearchFilters, page: number, perPage: number, langAr: boolean) {
  const start = Math.max(0, (page - 1) * perPage);
  return {
    draw: page,
    start,
    length: perPage,
    CR_NO: f.crNumber ?? "",
    CR_LNM: f.nameEn ?? "",
    CR_ANM: f.nameAr ?? "",
    CM_TYP_CD: quoteCodes(f.type),
    STATUS: quoteCodes(f.status),
    CR_MUNCP_CD: f.municipality ?? "",
    CR_BLOCK: f.block ?? "",
    CM_NAT_CD: quoteCodes(f.nationality),
    FIRST_LEV: f.sector ?? "",
    PTNER_LNM: f.partnerEn ?? "",
    PTNER_ANM: f.partnerAr ?? "",
    PTNER_NAT_CD: quoteCodes(f.partnerNat),
    REG_DATE_FROM: f.regFrom ?? "",
    REG_DATE_TO: f.regTo ?? "",
    CR_ROAD: f.road ?? "",
    CR_FLAT: f.flat ?? "",
    CR_BULD: f.building ?? "",
    PSPORT_NO: f.passport ?? "",
    PTNER_CR_NO: f.partnerCr ?? "",
    VCR_YN: f.regType ?? "",
    ISIC4_CD: quoteCodes(f.activity),
    CurrentMenuType: "A",
    cpr_no: "",
    CULT_LANG: langAr ? "AR" : "EN",
    PaginationParams: { Page: page, ItemPerPage: perPage },
  };
}

const isAllDigits = (s: string) => s.length > 0 && /^[0-9]+$/.test(s);

function needsResolve(v?: string): boolean {
  if (!v) return false;
  return v
    .split(",")
    .map((t) => t.trim().replace(/'/g, ""))
    .some((t) => t !== "" && !isAllDigits(t));
}

/** Maps comma-separated names/flags/codes to registry codes via a lookup table. */
function resolveCodes(table: CodeName[], value?: string): string {
  if (!value || table.length === 0) return value ?? "";
  const out: string[] = [];
  for (let tok of value.split(",")) {
    tok = tok.trim().replace(/'/g, "");
    if (!tok) continue;
    if (isAllDigits(tok)) {
      out.push(tok);
      continue;
    }
    const lower = tok.toLowerCase();
    const exact = table.find((e) => e.name.toLowerCase() === lower);
    if (exact) {
      out.push(exact.code);
      continue;
    }
    const byFlag = table.filter((e) => e.flag && e.flag.toLowerCase() === lower);
    if (byFlag.length) {
      out.push(...byFlag.map((e) => e.code));
      continue;
    }
    const sub = table.filter((e) => e.name.toLowerCase().includes(lower));
    out.push(sub.length === 1 ? sub[0].code : tok);
  }
  return out.join(",");
}

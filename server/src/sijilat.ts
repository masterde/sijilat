// Sijilat registry client: token mint + cache, search, AES-encrypted detail,
// lookup tables, and name->code filter resolution. Ported from the Go CLI.

import { encryptBody, tokenPassword, TOKEN_USERNAME } from "./crypto.js";

const DEFAULT_BASE_URL = "https://api.sijilat.bh/api/";
const USER_AGENT = "sijilat-api (+https://github.com/mvanhorn/printing-press-library)";

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

  constructor(baseUrl = process.env.SIJILAT_BASE_URL || DEFAULT_BASE_URL) {
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
      const resp = await fetch(this.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body,
      });
      if (resp.status === 429) throw new RateLimitError(this.tokenUrl);
      if (!resp.ok) throw new SijilatError(`token endpoint returned HTTP ${resp.status}`, resp.status);
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

    const resp = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        "content-type": contentType,
        accept: "*/*",
        authorization: `Bearer ${tok}`,
        "user-agent": USER_AGENT,
      },
      body: payload,
    });
    if (resp.status === 429) throw new RateLimitError(this.baseUrl + path);
    if (!resp.ok) throw new SijilatError(`POST ${path} returned HTTP ${resp.status}`, resp.status);
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

  /** Resolves human-readable status/type/nationality/sector/municipality names to codes. */
  private async resolveFilters(f: SearchFilters): Promise<SearchFilters> {
    const needs = [f.status, f.type, f.nationality, f.sector, f.municipality].some(needsResolve);
    if (!needs) return f;
    const lt = await this.lookups();
    return {
      ...f,
      status: resolveCodes(lt.status, f.status),
      type: resolveCodes(lt.types, f.type),
      nationality: resolveCodes(lt.nationalities, f.nationality),
      sector: resolveCodes(lt.sectors, f.sector),
      municipality: resolveCodes(lt.municipalities, f.municipality),
    };
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

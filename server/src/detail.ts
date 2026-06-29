// Parses a CompleteCRDetails payload into an agent-friendly company profile.
// Mirrors the Go CLI's ParseDetail.

export interface ParsedDetail {
  cr_number: string;
  branch: string;
  name_en: string;
  name_ar: string;
  group_name_en?: string;
  nationality?: string;
  company_type: string;
  status: string;
  registered_on: string;
  expires_on: string;
  address: Record<string, string>;
  capital: Record<string, string>;
  people: Person[];
  amendments: Amendment[];
  branches: Branch[];
}

interface Person {
  name: string;
  name_ar?: string;
  nationality?: string;
  role: string;
  shares?: string;
  ratio?: string;
  position?: string;
}

interface Amendment {
  date: string;
  action: string;
  application_no?: string;
}

interface Branch {
  cr_number: string;
  branch: string;
  name?: string;
  status?: string;
  registered_on?: string;
  expires_on?: string;
}

const s = (o: any, k: string): string => {
  const v = o?.[k];
  return typeof v === "string" ? v.trim() : "";
};
const first = (...vals: string[]): string => vals.find((v) => v) ?? "";
const clean = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x));

export function parseDetail(jsonData: any): ParsedDetail {
  const root = jsonData ?? {};
  const summary = root.company_summary ?? {};
  const addr = root.commercialAddress ?? {};
  const cap = root.companyCapitalDetails ?? {};
  const list = (k: string): any[] => (Array.isArray(root[k]) ? root[k] : []);

  const people: Person[] = [];
  for (const sh of list("shareholdersAndPartners")) {
    const name = first(s(sh, "LNM"), s(sh, "NAME"));
    if (!name) continue;
    people.push({
      name,
      name_ar: s(sh, "ANM") || undefined,
      nationality: first(s(sh, "NAT_LNM"), s(sh, "NAT_NAME")) || undefined,
      role: "shareholder",
      shares: s(sh, "NUM_SHARE") || undefined,
      ratio: s(sh, "RATIO_ONER") || undefined,
    });
  }
  for (const d of list("boardofDirectors")) {
    const name = s(d, "LNM");
    if (!name) continue;
    people.push({
      name,
      name_ar: s(d, "ANM") || undefined,
      nationality: first(s(d, "NAT_LNM"), s(d, "NAT_NM")) || undefined,
      role: "director",
      position: s(d, "POSITION_NM") || undefined,
    });
  }
  for (const sig of list("authorizedSignatories")) {
    const name = first(s(sig, "LNM"), s(sig, "NAME"));
    if (!name) continue;
    people.push({
      name,
      name_ar: s(sig, "ANM") || undefined,
      nationality: s(sig, "NAT_NM") || undefined,
      role: "signatory",
      position: s(sig, "SIG_LEV") || undefined,
    });
  }

  const amendments: Amendment[] = list("amendhistory")
    .map((a) => ({
      date: s(a, "CRT_DATE"),
      action: first(s(a, "AMEND_LNM"), s(a, "AMEND_NM")),
      application_no: s(a, "APP_NO") || undefined,
      _sort: s(a, "CRT_DATE_IF"),
    }))
    .sort((x, y) => (y._sort > x._sort ? 1 : y._sort < x._sort ? -1 : 0))
    .map(({ _sort, ...rest }) => rest);

  const branches: Branch[] = list("otherbranchlist").map((b) => ({
    cr_number: s(b, "CR_NO"),
    branch: s(b, "BRANCH_NO"),
    name: s(b, "CR_NAME") || undefined,
    status: s(b, "STATUS") || undefined,
    registered_on: s(b, "REG_DATE") || undefined,
    expires_on: s(b, "EXPIRE_DATE") || undefined,
  }));

  return {
    cr_number: s(summary, "CR_NO"),
    branch: s(summary, "BRANCH_NO"),
    name_en: s(summary, "CR_LNM"),
    name_ar: s(summary, "CR_ANM"),
    group_name_en: s(summary, "CR_GRP_LNM") || undefined,
    nationality: s(summary, "CR_NAT") || undefined,
    company_type: s(summary, "CM_TYP_DESC"),
    status: s(summary, "STATUS"),
    registered_on: s(summary, "REG_DATE"),
    expires_on: s(summary, "EXPIRE_DATE"),
    address: clean({
      flat: s(addr, "CR_FLAT"),
      building: s(addr, "CR_BULD"),
      road: s(addr, "CR_ROAD"),
      road_name: s(addr, "CR_ROAD_NM"),
      block: s(addr, "CR_BLOCK"),
      town: s(addr, "CR_TOWN_NM"),
      po_box: s(addr, "CR_PBOX"),
      email: s(addr, "CR_EMAIL"),
      mobile: s(addr, "CR_NAT_MOBILE"),
      phone: s(addr, "CR_NAT_PHONE_BIS"),
      fax: s(addr, "CR_NAT_FAX"),
      website: first(s(addr, "CR_URL"), s(addr, "ESTORE_URL")),
    }),
    capital: clean({
      authorized: s(cap, "AUTH_CAPTL"),
      issued: s(cap, "ISU_CAPTL"),
      total_shares: s(cap, "TOT_SHARE"),
      nominal_value: s(cap, "NOM_VAL"),
      currency: s(cap, "CURR_CD"),
      local_investment: s(cap, "LOCAL_INVEST_SUM"),
      gcc_investment: s(cap, "GCC_INVEST_SUM"),
      foreign_investment: s(cap, "FOR_INVEST_SUM"),
    }),
    people,
    amendments,
    branches,
  };
}

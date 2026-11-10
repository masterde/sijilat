// Contact shaping shared by the MCP server and the bulk export script: the
// commercial-address contacts from CompleteCRDetails plus the owner contact
// from the latest GET LICENSE application, with phones normalised to E.164.

import { isUpstreamStop, type SijilatClient } from "./sijilat.js";
import { parseDetail } from "./detail.js";

export interface Contacts {
  cr_number: string;
  branch: string;
  name_en: string;
  name_ar: string;
  status: string;
  phone?: string;
  mobile?: string;
  fax?: string;
  email?: string;
  website?: string;
  address?: string;
  /** Contact from the latest GET LICENSE filing — usually the owner's own number. */
  owner_contact?: {
    phone?: string;
    mobile?: string;
    fax?: string;
    email?: string;
    application_no: string;
    filed_on: string;
  } | null;
}

/**
 * Normalises a registry phone like "( ++973 ) 17574333" to E.164
 * ("+97317574333"). Bare 8-digit Bahraini numbers get +973. Returns undefined
 * for blanks, all-zero placeholders and country-code-only values ("( +973 )").
 */
export function normalizePhone(raw?: string): string | undefined {
  if (!raw) return undefined;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 8) digits = "973" + digits;
  if (digits.length < 9 || /^0+$/.test(digits) || /^9730+$/.test(digits)) return undefined;
  return "+" + digits;
}

async function getOwnerContact(client: SijilatClient, crNumber: string, branch: string): Promise<Contacts["owner_contact"]> {
  const lc = await client.licenseContact(crNumber, branch);
  if (!lc) return null;
  return {
    phone: normalizePhone(lc.phone),
    mobile: normalizePhone(lc.mobile),
    fax: normalizePhone(lc.fax),
    email: lc.email || undefined,
    application_no: lc.application_no,
    filed_on: lc.filed_on,
  };
}

export async function getContacts(
  client: SijilatClient,
  crNumber: string,
  branch = "1",
  withOwner = true,
): Promise<Contacts> {
  const [raw, owner] = await Promise.all([
    client.detail(crNumber, branch),
    // A failed owner lookup shouldn't sink the whole record, except when the
    // registry is refusing us: then the row must fail loudly, not pass as an
    // old CR with no owner on file.
    withOwner
      ? getOwnerContact(client, crNumber, branch).catch((e) => {
          if (isUpstreamStop(e)) throw e;
          return undefined;
        })
      : Promise.resolve(undefined),
  ]);
  const d = parseDetail(raw);
  // Unknown CRs come back as an empty-but-successful payload.
  if (!d.name_en && !d.name_ar && !d.cr_number) throw new Error(`no business found for CR ${crNumber} branch ${branch}`);
  const a = d.address;
  const address = [
    a.flat && `Flat ${a.flat}`,
    a.building && `Bldg ${a.building}`,
    a.road_name || (a.road && `Road ${a.road}`),
    a.block && `Block ${a.block}`,
    a.town,
  ]
    .filter((x) => x && x !== "Flat 0")
    .join(", ");
  return {
    cr_number: d.cr_number || crNumber,
    branch: d.branch || branch,
    name_en: d.name_en,
    name_ar: d.name_ar,
    status: d.status,
    phone: normalizePhone(a.phone),
    mobile: normalizePhone(a.mobile),
    fax: normalizePhone(a.fax),
    email: a.email || undefined,
    website: a.website || undefined,
    address: address || undefined,
    owner_contact: owner,
  };
}

export const hasAnyPhone = (c: Contacts) => !!(c.phone || c.mobile || c.owner_contact?.phone || c.owner_contact?.mobile);

/** Runs fn over items with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Eat For Less — the outside checks: Food Standards Agency hygiene ratings
// and Companies House.
//
// The FSA ratings API is free and needs no key. Companies House needs a free
// API key (COMPANIES_HOUSE_API_KEY); without one that check reports "not
// checked" rather than failing the application.

import { Injectable, Logger } from "@nestjs/common";

const FSA_API = "https://api.ratings.food.gov.uk";
const COMPANIES_HOUSE_API = "https://api.company-information.service.gov.uk";

export interface HygieneResult {
  establishmentId: string;
  businessName: string;
  postcode: string | null;
  /** "0"–"5" in England, Wales and Northern Ireland; "Pass",
   *  "Pass and Eat Safe" or "Improvement Required" in Scotland; or a state
   *  like "AwaitingInspection" / "Exempt". */
  rating: string;
  ratingDate: string | null;
}

export interface CompanyResult {
  found: boolean;
  name: string | null;
  active: boolean;
}

/** The FSA establishment id from a ratings.food.gov.uk link, or null.
 *  Links look like /business/1234567/some-name or /business/en-GB/1234567. */
export function fsaIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /ratings\.food\.gov\.uk\/business\/(?:[a-z]{2}-[A-Z]{2}\/)?(\d{3,})/i.exec(url);
  return m ? m[1]! : null;
}

/**
 * Is this rating below the platform minimum?
 *
 * Numbers compare directly. Scotland's "Improvement Required" always counts
 * as below. A shop the FSA hasn't rated yet ("AwaitingInspection",
 * "Exempt", …) is NOT below — there is nothing to hold against it, and new
 * shops would otherwise never get listed.
 */
export function ratingBelowMinimum(rating: string | null | undefined, minimum: number): boolean {
  if (!rating) return false;
  const r = rating.trim();
  if (/^\d$/.test(r)) return Number(r) < minimum;
  return /improvement required/i.test(r);
}

/** Companies House numbers are 8 characters, zero-padded; people type "123456". */
export function normaliseCompanyNumber(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(s)) return null;
  return /^\d+$/.test(s) ? s.padStart(8, "0") : s;
}

/** Pick an FSA search result for a shop: same postcode first, then the
 *  closest name. Null when nothing at that postcode looks like it. */
export function pickEstablishment(
  results: HygieneResult[],
  shop: { name: string; postcode: string },
): HygieneResult | null {
  const pc = shop.postcode.replace(/\s+/g, "").toUpperCase();
  const samePostcode = results.filter((r) => (r.postcode ?? "").replace(/\s+/g, "").toUpperCase() === pc);
  if (samePostcode.length === 0) return null;
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const want = words(shop.name);
  const scored = samePostcode
    .map((r) => ({ r, score: [...words(r.businessName)].filter((w) => want.has(w)).length }))
    .sort((a, b) => b.score - a.score);
  return samePostcode.length === 1 || scored[0]!.score > 0 ? scored[0]!.r : null;
}

function toHygieneResult(e: any): HygieneResult | null {
  if (!e?.FHRSID) return null;
  return {
    establishmentId: String(e.FHRSID),
    businessName: String(e.BusinessName ?? ""),
    postcode: e.PostCode ? String(e.PostCode) : null,
    rating: String(e.RatingValue ?? ""),
    ratingDate: e.RatingDate ? String(e.RatingDate) : null,
  };
}

@Injectable()
export class EflChecksService {
  private readonly logger = new Logger(EflChecksService.name);

  private async fsa(path: string): Promise<any | null> {
    try {
      const res = await fetch(`${FSA_API}${path}`, {
        headers: { "x-api-version": "2", accept: "application/json" },
      });
      if (!res.ok) {
        this.logger.warn(`FSA ${path} → HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      this.logger.warn(`FSA ${path} failed: ${(err as Error).message}`);
      return null;
    }
  }

  async hygieneById(establishmentId: string): Promise<HygieneResult | null> {
    return toHygieneResult(await this.fsa(`/Establishments/${encodeURIComponent(establishmentId)}`));
  }

  /** Find a shop by link if one was given, else by name at its postcode. */
  async findHygiene(shop: { url?: string | null; name: string; postcode: string }): Promise<HygieneResult | null> {
    const id = fsaIdFromUrl(shop.url);
    if (id) return this.hygieneById(id);
    const data = await this.fsa(
      `/Establishments?name=${encodeURIComponent(shop.name)}&address=${encodeURIComponent(shop.postcode)}&pageSize=20`,
    );
    const results = ((data?.establishments ?? []) as any[])
      .map(toHygieneResult)
      .filter((r): r is HygieneResult => r !== null);
    return pickEstablishment(results, shop);
  }

  /** Null when there is no API key — "not checked", not "not found". */
  async company(rawNumber: string | null | undefined): Promise<CompanyResult | null> {
    const key = process.env.COMPANIES_HOUSE_API_KEY;
    const number = normaliseCompanyNumber(rawNumber);
    if (!key || !number) return null;
    try {
      const res = await fetch(`${COMPANIES_HOUSE_API}/company/${number}`, {
        headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
      });
      if (res.status === 404) return { found: false, name: null, active: false };
      if (!res.ok) {
        this.logger.warn(`Companies House ${number} → HTTP ${res.status}`);
        return null;
      }
      const body: any = await res.json();
      return {
        found: true,
        name: body?.company_name ?? null,
        active: String(body?.company_status ?? "").toLowerCase() === "active",
      };
    } catch (err) {
      this.logger.warn(`Companies House ${number} failed: ${(err as Error).message}`);
      return null;
    }
  }
}

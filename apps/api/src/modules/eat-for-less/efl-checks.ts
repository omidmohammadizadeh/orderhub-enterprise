// Eat For Less — the outside checks: Food Standards Agency hygiene ratings
// and Companies House.
//
// The FSA ratings API is free and needs no key. Companies House needs a free
// API key (COMPANIES_HOUSE_API_KEY); without one that check reports "not
// checked" rather than failing the application.

import { Injectable, Logger } from "@nestjs/common";
import { FsaRatingsClient, type HygieneResult } from "../../common/fsa-ratings";

// The FSA client lives in common/ now (the storefront hygiene badge uses it
// too); re-exported so existing imports keep working.
export { fsaIdFromUrl, pickEstablishment } from "../../common/fsa-ratings";
export type { HygieneResult } from "../../common/fsa-ratings";

const COMPANIES_HOUSE_API = "https://api.company-information.service.gov.uk";

export interface CompanyResult {
  found: boolean;
  name: string | null;
  active: boolean;
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

@Injectable()
export class EflChecksService {
  private readonly logger = new Logger(EflChecksService.name);

  private readonly fsa = new FsaRatingsClient();

  hygieneById(establishmentId: string): Promise<HygieneResult | null> {
    return this.fsa.hygieneById(establishmentId);
  }

  /** Find a shop by link if one was given, else by name at its postcode. */
  findHygiene(shop: { url?: string | null; name: string; postcode: string }): Promise<HygieneResult | null> {
    return this.fsa.findHygiene(shop);
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

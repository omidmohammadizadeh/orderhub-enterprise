// UK Food Standards Agency food hygiene ratings — the API client.
//
// Free, no key: https://api.ratings.food.gov.uk with `x-api-version: 2`.
// Used by Eat For Less (listing checks) and by every location's storefront
// badge (modules/hygiene). Every lookup returns null on any failure — the
// callers' rule is "a failed FSA call changes nothing".

import { Logger } from "@nestjs/common";

const FSA_API = "https://api.ratings.food.gov.uk";

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

/** The FSA establishment id from a ratings.food.gov.uk link, or null.
 *  Links look like /business/1234567/some-name or /business/en-GB/1234567. */
export function fsaIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /ratings\.food\.gov\.uk\/business\/(?:[a-z]{2}-[A-Z]{2}\/)?(\d{3,})/i.exec(url);
  return m ? m[1]! : null;
}

/** The public ratings page for an establishment. */
export function fsaBusinessUrl(establishmentId: string): string {
  return `https://ratings.food.gov.uk/business/${encodeURIComponent(establishmentId)}`;
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

export function toHygieneResult(e: any): HygieneResult | null {
  if (!e?.FHRSID) return null;
  return {
    establishmentId: String(e.FHRSID),
    businessName: String(e.BusinessName ?? ""),
    postcode: e.PostCode ? String(e.PostCode) : null,
    rating: String(e.RatingValue ?? ""),
    ratingDate: e.RatingDate ? String(e.RatingDate) : null,
  };
}

/** Plain class (not a provider) so any Nest service can hold one. */
export class FsaRatingsClient {
  private readonly logger = new Logger(FsaRatingsClient.name);

  private async get(path: string): Promise<any | null> {
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
    return toHygieneResult(await this.get(`/Establishments/${encodeURIComponent(establishmentId)}`));
  }

  /** Find a shop by link if one was given, else by name at its postcode. */
  async findHygiene(shop: { url?: string | null; name: string; postcode: string }): Promise<HygieneResult | null> {
    const id = fsaIdFromUrl(shop.url);
    if (id) return this.hygieneById(id);
    const data = await this.get(
      `/Establishments?name=${encodeURIComponent(shop.name)}&address=${encodeURIComponent(shop.postcode)}&pageSize=20`,
    );
    const results = ((data?.establishments ?? []) as any[])
      .map(toHygieneResult)
      .filter((r): r is HygieneResult => r !== null);
    return pickEstablishment(results, shop);
  }
}

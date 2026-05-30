// Phase AM — UK postcode → addresses providers.
//
// Two are wired today (getaddress.io paid, postcodes.io free) and three
// vendor adapters are stubbed so the next phase can light them up by
// just dropping in their HTTP calls. Each stub throws a clear "not
// configured" error from searchByPostcode so the provider chain in
// AddressLookupService falls through cleanly.

import { Logger } from "@nestjs/common";
import type { AddressSuggestion, PostcodeProvider } from "./types";

// ── getaddress.io (Royal Mail PAF, paid, recommended) ──────────────────────
export class GetAddressProvider implements PostcodeProvider {
  readonly id = "getaddress" as const;
  private readonly logger = new Logger(GetAddressProvider.name);

  isConfigured(): boolean {
    return !!process.env.GETADDRESS_API_KEY;
  }

  async searchByPostcode(postcode: string): Promise<AddressSuggestion[]> {
    const key = process.env.GETADDRESS_API_KEY!;
    const url =
      `https://api.getaddress.io/find/${encodeURIComponent(postcode)}` +
      `?api-key=${key}&expand=true`;
    const res = await fetch(url);
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(`getaddress.io ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      latitude?: number;
      longitude?: number;
      postcode?: string;
      addresses: Array<{
        line_1?: string;
        line_2?: string;
        line_3?: string;
        line_4?: string;
        locality?: string;
        town_or_city?: string;
        county?: string;
        country?: string;
        postcode?: string;
        latitude?: number;
        longitude?: number;
      }>;
    };
    const formattedPostcode =
      data.postcode ?? `${postcode.slice(0, -3)} ${postcode.slice(-3)}`;
    return (data.addresses ?? []).map((a, idx) => {
      const line1 = (a.line_1 ?? "").trim();
      const line2 = [a.line_2, a.line_3, a.line_4]
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .join(", ");
      const town = a.town_or_city ?? a.locality ?? "";
      return {
        id: `getaddress:${postcode}:${idx}`,
        label: [line1, line2, town, formattedPostcode].filter(Boolean).join(", "),
        line1,
        line2: line2 || undefined,
        city: town || undefined,
        postcode: formattedPostcode,
        country: a.country ?? "GB",
        latitude: a.latitude ?? data.latitude,
        longitude: a.longitude ?? data.longitude,
        provider: "getaddress" as const,
      };
    });
  }
}

// ── Nominatim / OpenStreetMap (free, no key, returns street names) ─────────
//
// Bridges the gap between postcodes.io (city only) and a paid PAF provider
// (every door). Returns the streets known at a postcode, with town/county/
// postcode pre-filled. The operator still adds the house number, but at
// least sees the right road in the dropdown.
//
// OSM usage policy:
//   • Absolute max 1 request/second per IP
//   • Identify yourself via a real User-Agent including a contact address
//   • No bulk harvesting
//
// We enforce the 1 req/sec rate at the process level via an in-memory
// timestamp; for a typical POS firing a postcode lookup every few seconds
// this is invisible. Heavy use → swap to a paid provider.
export class NominatimProvider implements PostcodeProvider {
  readonly id = "nominatim" as const;
  private readonly logger = new Logger(NominatimProvider.name);
  private lastCallAt = 0;

  isConfigured(): boolean {
    // Always available — no key required. Disable explicitly with
    // ADDRESS_LOOKUP_DISABLE_NOMINATIM=true if a tenant doesn't want
    // to depend on OSM.
    return process.env.ADDRESS_LOOKUP_DISABLE_NOMINATIM !== "true";
  }

  private async throttle(): Promise<void> {
    const minGapMs = 1100; // 1.1s — safely under OSM's 1 req/sec limit
    const wait = this.lastCallAt + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  private userAgent(): string {
    return (
      process.env.ADDRESS_LOOKUP_USER_AGENT ??
      "OrderHub-POS/1.0 (+https://orderhub.io; admin@orderhub.io)"
    );
  }

  async searchByPostcode(postcode: string): Promise<AddressSuggestion[]> {
    await this.throttle();

    // Re-pretty the postcode for the search query — Nominatim is fussier
    // about whitespace than getaddress.io.
    const pretty = `${postcode.slice(0, -3)} ${postcode.slice(-3)}`;
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?postalcode=${encodeURIComponent(pretty)}` +
      `&country=gb` +
      `&format=jsonv2` +
      `&addressdetails=1` +
      `&limit=20`;

    const res = await fetch(url, {
      headers: { "User-Agent": this.userAgent() },
    });
    if (!res.ok) {
      throw new Error(`Nominatim ${res.status} ${res.statusText}`);
    }
    const features = (await res.json()) as Array<{
      display_name: string;
      lat?: string;
      lon?: string;
      address?: {
        road?: string;
        pedestrian?: string;
        residential?: string;
        neighbourhood?: string;
        suburb?: string;
        village?: string;
        town?: string;
        city?: string;
        municipality?: string;
        county?: string;
        postcode?: string;
        country_code?: string;
      };
    }>;

    // Dedupe by street name — Nominatim often returns the same road
    // multiple times tagged as different node types.
    const seen = new Set<string>();
    const suggestions: AddressSuggestion[] = [];
    for (const f of features) {
      const a = f.address ?? {};
      const street =
        a.road ?? a.pedestrian ?? a.residential ?? a.neighbourhood ?? "";
      if (!street) continue;
      const town = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ?? "";
      const postcodeOut = a.postcode ?? pretty;
      const key = `${street}|${town}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      suggestions.push({
        id: `nominatim:${postcode}:${suggestions.length}`,
        // Hint to the operator that they still need to add a house number.
        label: `${street}${town ? `, ${town}` : ""}, ${postcodeOut} — add house/flat`,
        line1: street,
        city: town || undefined,
        postcode: postcodeOut,
        country: a.country_code ? a.country_code.toUpperCase() : "GB",
        latitude: f.lat ? Number(f.lat) : undefined,
        longitude: f.lon ? Number(f.lon) : undefined,
        provider: "nominatim" as const,
      });
    }

    return suggestions;
  }
}

// ── postcodes.io (free, no key, town-only) ─────────────────────────────────
//
// Doesn't enumerate per-house addresses — those are paywalled PAF data.
// But it always works without any setup, and pre-fills town + postcode
// so the operator only has to type the building/house number.
export class PostcodesIoProvider implements PostcodeProvider {
  readonly id = "postcodes_io" as const;

  isConfigured(): boolean {
    // Always available — no key required.
    return true;
  }

  async searchByPostcode(postcode: string): Promise<AddressSuggestion[]> {
    const res = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`,
    );
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(`postcodes.io ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      result?: {
        postcode: string;
        admin_district?: string;
        admin_ward?: string;
        parish?: string;
        admin_county?: string;
        country?: string;
        latitude?: number;
        longitude?: number;
      };
    };
    if (!data.result) return [];
    const r = data.result;
    const city = r.admin_district ?? r.admin_ward ?? r.parish ?? "";
    const label = [city, r.postcode].filter(Boolean).join(", ");
    return [
      {
        id: `postcodes_io:${r.postcode}`,
        label: `${label} — add house/flat number`,
        line1: "",
        city,
        postcode: r.postcode,
        country: r.country ?? "GB",
        latitude: r.latitude,
        longitude: r.longitude,
        provider: "postcodes_io" as const,
      },
    ];
  }
}

// ── Stubbed paid alternatives ───────────────────────────────────────────────
//
// Each one wires the env-var check + a clear "not configured" error so
// the provider chain falls through cleanly. When you sign up for one,
// drop the HTTP call into searchByPostcode and the chain picks it up
// (subject to ordering in address-lookup.module.ts).

export class IdealPostcodesProvider implements PostcodeProvider {
  readonly id = "ideal_postcodes" as const;

  isConfigured(): boolean {
    return !!process.env.IDEAL_POSTCODES_API_KEY;
  }

  async searchByPostcode(_postcode: string): Promise<AddressSuggestion[]> {
    // TODO Phase AN — implement:
    //   GET https://api.ideal-postcodes.co.uk/v1/postcodes/<pc>?api_key=...
    //   Returns { result: [{ line_1, line_2, line_3, post_town, postcode, ... }] }
    throw new Error(
      "ideal_postcodes provider not yet implemented (env IDEAL_POSTCODES_API_KEY is set but HTTP call is stubbed)",
    );
  }
}

export class LoqateProvider implements PostcodeProvider {
  readonly id = "loqate" as const;

  isConfigured(): boolean {
    return !!process.env.LOQATE_API_KEY;
  }

  async searchByPostcode(_postcode: string): Promise<AddressSuggestion[]> {
    // TODO Phase AN — implement:
    //   GET https://services.postcodeanywhere.co.uk/Capture/Interactive/Find/v1.10/json3.ws
    //     ?Key=...&Text=<pc>&Container=&Origin=GBR&Countries=GB&Limit=20&Language=en-GB
    //   Then per Id, GET Retrieve/v1.20/json3.ws for full address.
    throw new Error(
      "loqate provider not yet implemented (env LOQATE_API_KEY is set but HTTP call is stubbed)",
    );
  }
}

export class PostcoderProvider implements PostcodeProvider {
  readonly id = "postcoder" as const;

  isConfigured(): boolean {
    return !!process.env.POSTCODER_API_KEY;
  }

  async searchByPostcode(_postcode: string): Promise<AddressSuggestion[]> {
    // TODO Phase AN — implement:
    //   GET https://ws.postcoder.com/pcw/<api_key>/address/uk/<pc>?format=json&lines=2
    //   Returns [{ addressline1, addressline2, posttown, postcode, ... }]
    throw new Error(
      "postcoder provider not yet implemented (env POSTCODER_API_KEY is set but HTTP call is stubbed)",
    );
  }
}

export class RoyalMailProvider implements PostcodeProvider {
  readonly id = "royal_mail" as const;

  isConfigured(): boolean {
    return !!process.env.ROYAL_MAIL_PAF_KEY;
  }

  async searchByPostcode(_postcode: string): Promise<AddressSuggestion[]> {
    // TODO Phase AN — Direct PAF licence access via Royal Mail's HTTP
    // bulk-licence API. Significantly more expensive — only sensible at
    // very high volume (>100k lookups/month).
    throw new Error(
      "royal_mail provider not yet implemented (env ROYAL_MAIL_PAF_KEY is set but HTTP call is stubbed)",
    );
  }
}

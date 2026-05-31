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

// ── OSM Streets (free, no key, returns street names per postcode) ──────────
//
// Two-step OSM chain — Nominatim's /search?postalcode endpoint only returns
// the postcode CENTROID for most UK postcodes, not the streets in it. So
// we instead:
//
//   1. Ask postcodes.io for the postcode's lat/lng + admin district
//      (free, fast, no key, no rate limit to speak of).
//   2. Ask Overpass API for every named highway within 250m of those
//      coords. Overpass is the OSM data-query engine — purpose-built for
//      "list ways with these tags in this area".
//
// Result: dozens of actual road names for the postcode area, dedupe'd by
// name, sorted alphabetically. The operator picks one and types the
// house number on top. Full per-house data still needs PAF
// (GETADDRESS_API_KEY).
//
// Overpass usage policy: be reasonable. Public servers absorb ~2 req/sec
// per IP comfortably. We add a small in-process gap.
//
// Disable entirely with ADDRESS_LOOKUP_DISABLE_OSM=true if a tenant doesn't
// want to depend on OSM endpoints.
export class OsmStreetsProvider implements PostcodeProvider {
  readonly id = "osm" as const;
  private readonly logger = new Logger(OsmStreetsProvider.name);
  private lastOverpassCallAt = 0;

  isConfigured(): boolean {
    return process.env.ADDRESS_LOOKUP_DISABLE_OSM !== "true";
  }

  private userAgent(): string {
    return (
      process.env.ADDRESS_LOOKUP_USER_AGENT ??
      "OrderHub-POS/1.0 (+https://orderhub.io; admin@orderhub.io)"
    );
  }

  private async throttleOverpass(): Promise<void> {
    const minGapMs = 500;
    const wait = this.lastOverpassCallAt + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastOverpassCallAt = Date.now();
  }

  async searchByPostcode(postcode: string): Promise<AddressSuggestion[]> {
    // Re-pretty the postcode (postcodes.io is tolerant either way).
    const pretty = `${postcode.slice(0, -3)} ${postcode.slice(-3)}`;

    // Step 1 — postcodes.io for coords + admin district.
    const pioRes = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(pretty)}`,
    );
    if (pioRes.status === 404) return [];
    if (!pioRes.ok) {
      throw new Error(`postcodes.io ${pioRes.status} ${pioRes.statusText}`);
    }
    const pio = (await pioRes.json()) as {
      result?: {
        latitude?: number;
        longitude?: number;
        postcode: string;
        admin_district?: string;
        admin_ward?: string;
        parish?: string;
        country?: string;
      };
    };
    if (!pio.result?.latitude || !pio.result?.longitude) return [];

    const { latitude, longitude } = pio.result;
    const town =
      pio.result.admin_district ??
      pio.result.admin_ward ??
      pio.result.parish ??
      "";
    const postcodeOut = pio.result.postcode;

    // Step 2 — Overpass for every named highway within 250m of those
    // coords. When Overpass times out / 429s / is blocked by the host
    // network (we've seen this happen on Render's outbound IPs) we
    // fall back to Nominatim's reverse geocode inside THIS provider
    // instead of throwing — otherwise the outer chain falls through
    // to postcodes.io which only knows the town, and the operator's
    // street picker disappears.
    const overpassStreets = await this.tryOverpass(latitude, longitude);
    if (overpassStreets.length > 0) {
      return overpassStreets.map((street, idx) => ({
        id: `osm:${postcode}:${idx}`,
        label: `${street}${town ? `, ${town}` : ""}, ${postcodeOut} — add house/flat`,
        line1: street,
        city: town || undefined,
        postcode: postcodeOut,
        country: "GB",
        latitude,
        longitude,
        provider: "osm" as const,
      }));
    }

    const nominatimStreets = await this.tryNominatim(latitude, longitude);
    if (nominatimStreets.length > 0) {
      return nominatimStreets.map((street, idx) => ({
        id: `osm:${postcode}:nom:${idx}`,
        label: `${street}${town ? `, ${town}` : ""}, ${postcodeOut} — add house/flat`,
        line1: street,
        city: town || undefined,
        postcode: postcodeOut,
        country: "GB",
        latitude,
        longitude,
        provider: "osm" as const,
      }));
    }

    // Last-resort: at least give the operator the town + postcode so
    // they can finish manually.
    return [
      {
        id: `osm:${postcode}:town`,
        label: `${town}, ${postcodeOut} — add street + house/flat`,
        line1: "",
        city: town || undefined,
        postcode: postcodeOut,
        country: "GB",
        latitude,
        longitude,
        provider: "osm" as const,
      },
    ];
  }

  /** Overpass query for named highways near the coords. Catches all
   *  errors so the caller can decide to fall back. */
  private async tryOverpass(lat: number, lng: number): Promise<string[]> {
    try {
      await this.throttleOverpass();
      const query =
        `[out:json][timeout:25];` +
        `way["highway"]["name"](around:250,${lat},${lng});` +
        `out tags;`;
      const overpassUrl =
        `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
      const opRes = await fetch(overpassUrl, {
        headers: { "User-Agent": this.userAgent() },
      });
      if (!opRes.ok) {
        this.logger.warn(`Overpass ${opRes.status} ${opRes.statusText}`);
        return [];
      }
      const data = (await opRes.json()) as {
        elements?: Array<{ tags?: { name?: string; highway?: string } }>;
      };
      const seen = new Set<string>();
      const streets: string[] = [];
      for (const el of data.elements ?? []) {
        const name = el.tags?.name?.trim();
        const highway = el.tags?.highway;
        if (!name) continue;
        if (highway === "motorway" || highway === "trunk") continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        streets.push(name);
      }
      streets.sort((a, b) => a.localeCompare(b, "en-GB"));
      return streets;
    } catch (err: any) {
      this.logger.warn(`Overpass exception: ${err?.message ?? err}`);
      return [];
    }
  }

  /** Nominatim reverse geocode at coords + a handful of small jitters
   *  around the postcode centroid so we collect multiple road names
   *  even when the postcode covers more than one street. Each call is
   *  rate-limited at 1.1s per the OSM policy. */
  private async tryNominatim(lat: number, lng: number): Promise<string[]> {
    const seen = new Set<string>();
    const streets: string[] = [];
    // 5 sample points within ~80m of the postcode centroid.
    const jitters: Array<[number, number]> = [
      [0, 0],
      [0.0008, 0],
      [-0.0008, 0],
      [0, 0.0012],
      [0, -0.0012],
    ];
    for (const [dLat, dLng] of jitters) {
      try {
        await this.throttleNominatim();
        const url =
          `https://nominatim.openstreetmap.org/reverse` +
          `?lat=${lat + dLat}&lon=${lng + dLng}` +
          `&format=jsonv2&addressdetails=1&zoom=17`;
        const res = await fetch(url, {
          headers: { "User-Agent": this.userAgent() },
        });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          address?: { road?: string; pedestrian?: string; residential?: string };
        };
        const road =
          data.address?.road ??
          data.address?.pedestrian ??
          data.address?.residential;
        if (!road) continue;
        const key = road.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        streets.push(road);
      } catch (err: any) {
        this.logger.warn(`Nominatim reverse exception: ${err?.message ?? err}`);
      }
    }
    streets.sort((a, b) => a.localeCompare(b, "en-GB"));
    return streets;
  }

  private lastNominatimCallAt = 0;
  private async throttleNominatim(): Promise<void> {
    // OSM's policy is strict: max 1 req/sec per IP. Keep a 1.1s gap.
    const minGapMs = 1100;
    const wait = this.lastNominatimCallAt + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastNominatimCallAt = Date.now();
  }
}

/**
 * Backwards-compat export — kept so the module wiring doesn't break if
 * NominatimProvider is still referenced anywhere. Will be removed in
 * Phase AN.
 * @deprecated use OsmStreetsProvider instead
 */
export const NominatimProvider = OsmStreetsProvider;
export type NominatimProvider = OsmStreetsProvider;

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

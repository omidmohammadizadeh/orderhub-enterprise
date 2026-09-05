// Free text in, a whole address out.
//
// The postcode-first flow exists because a transcriber has never heard of
// Follingsby Drive and a postcode is seven characters from a fixed alphabet.
// That reasoning is sound and it still runs — but it costs three questions,
// and a caller who says "eleven Sunningdale Drive, Washington" has already
// answered all three. Taxi lines have taken a destination in one breath for
// years; there is no reason a takeaway cannot take an address the same way and
// keep the postcode ladder for when it doesn't land.
//
// The requirement that makes this usable is that the answer comes back WITH a
// postcode — we need it for the delivery zone, the driver and the receipt.
// Both providers here do:
//
//   "11 Sunningdale Drive Washington"  ->  Sunningdale Drive, Washington, NE37 2LL
//
// Nominatim needs no key, which matters: it means this works on day one for a
// shop that has never opened a Google console.

import { Logger } from "@nestjs/common";
import type { AddressSuggestion, AddressProviderId } from "./types";

const TIMEOUT_MS = Number(process.env.ADDRESS_FREETEXT_TIMEOUT_MS) || 2500;

export interface FreeTextOptions {
  /** ISO-2. */
  country: string;
  limit?: number;
}

export interface FreeTextProvider {
  readonly id: AddressProviderId;
  isConfigured(): boolean;
  resolve(query: string, opts: FreeTextOptions): Promise<AddressSuggestion[]>;
}

// -- Nominatim free-text search (no key) ------------------------------------
export class NominatimSearchProvider implements FreeTextProvider {
  readonly id = "osm" as const;
  private readonly logger = new Logger(NominatimSearchProvider.name);
  private lastCallAt = 0;

  isConfigured(): boolean {
    return process.env.ADDRESS_LOOKUP_DISABLE_OSM !== "true";
  }

  private userAgent(): string {
    return (
      process.env.ADDRESS_LOOKUP_USER_AGENT ??
      "OrderHub-POS/1.0 (+https://orderhub.io; admin@orderhub.io)"
    );
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  async resolve(query: string, opts: FreeTextOptions): Promise<AddressSuggestion[]> {
    await this.throttle();
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(query)}` +
      `&countrycodes=${encodeURIComponent((opts.country || "gb").toLowerCase())}` +
      `&format=jsonv2&addressdetails=1&limit=${opts.limit ?? 5}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": this.userAgent() },
    });
    if (!res.ok) {
      this.logger.warn(`Nominatim search ${res.status} ${res.statusText}`);
      return [];
    }
    const rows = (await res.json()) as Array<{
      lat?: string;
      lon?: string;
      address?: Record<string, string>;
    }>;
    return rows.map((r, idx) => fromOsmAddress(r, idx));
  }
}

function fromOsmAddress(
  row: { lat?: string; lon?: string; address?: Record<string, string> },
  idx: number,
): AddressSuggestion {
  const a = row.address ?? {};
  const road = a.road ?? a.pedestrian ?? a.residential ?? a.footway ?? "";
  const house = a.house_number ?? "";
  const city = a.town ?? a.city ?? a.village ?? a.suburb ?? a.county ?? "";
  const postcode = a.postcode ?? "";
  const line1 = [house, road].filter(Boolean).join(" ");
  return {
    id: `osm-search:${idx}`,
    label: [line1, city, postcode].filter(Boolean).join(", "),
    line1,
    city: city || undefined,
    postcode: postcode || undefined,
    country: "GB",
    latitude: row.lat ? Number(row.lat) : undefined,
    longitude: row.lon ? Number(row.lon) : undefined,
    provider: "osm" as const,
  };
}

// -- Google Geocoding (one call, when a server key is set) -------------------
//
// Places Autocomplete is the wrong tool on a phone call: two round trips, and
// it returns predictions to pick from. Geocoding takes the sentence and
// returns the address.
export class GoogleGeocodeProvider implements FreeTextProvider {
  readonly id = "google" as const;

  isConfigured(): boolean {
    return !!process.env.GOOGLE_MAPS_API_KEY;
  }

  async resolve(query: string, opts: FreeTextOptions): Promise<AddressSuggestion[]> {
    const key = process.env.GOOGLE_MAPS_API_KEY!;
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(query)}` +
      `&components=country:${(opts.country || "GB").toUpperCase()}` +
      `&key=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`google geocode HTTP ${res.status} ${res.statusText}`);
    const data = (await res.json()) as {
      status?: string;
      error_message?: string;
      results?: Array<{
        formatted_address?: string;
        address_components?: Array<{ long_name: string; types: string[] }>;
        geometry?: { location?: { lat: number; lng: number } };
      }>;
    };
    if (data.status === "ZERO_RESULTS") return [];
    if (data.status && data.status !== "OK") {
      throw new Error(
        `google geocode ${data.status}${data.error_message ? `: ${data.error_message}` : ""}`,
      );
    }
    return (data.results ?? []).slice(0, opts.limit ?? 5).map((r, idx) => {
      const pick = (type: string) =>
        r.address_components?.find((c) => c.types?.includes(type))?.long_name;
      const road = pick("route") ?? "";
      const house = pick("street_number") ?? pick("premise") ?? "";
      const city = pick("postal_town") ?? pick("locality") ?? undefined;
      const postcode = pick("postal_code") ?? undefined;
      const line1 = [house, road].filter(Boolean).join(" ");
      return {
        id: `google-geocode:${idx}`,
        label: r.formatted_address ?? [line1, city, postcode].filter(Boolean).join(", "),
        line1,
        city,
        postcode,
        country: "GB",
        latitude: r.geometry?.location?.lat,
        longitude: r.geometry?.location?.lng,
        provider: "google" as const,
      };
    });
  }
}

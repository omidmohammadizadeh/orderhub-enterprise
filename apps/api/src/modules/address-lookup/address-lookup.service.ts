import { Injectable, Logger } from "@nestjs/common";

// Phase AM — Address lookup provider abstraction.
//
// Two LOOKUP modes:
//   • autocomplete (`search`) — free-text typeahead via Mapbox / Google
//   • postcode lookup (`searchByPostcode`) — UK-style "enter a postcode,
//     pick from the list of addresses at that postcode" via
//     getaddress.io. This is what UK takeaways are used to from EPOS.
//
// Providers possible:
//   1. Mapbox — autocomplete, gated on MAPBOX_ACCESS_TOKEN
//   2. Google Places — placeholder, gated on GOOGLE_MAPS_API_KEY
//   3. getaddress.io — postcode lookup, gated on GETADDRESS_API_KEY
//      (Royal Mail PAF, ~£0.005/lookup or free tier)
//   4. Manual — always available, returns empty suggestions; the UI
//      lets the operator type the address by hand.
//
// We deliberately do not throw when no provider is configured — the POS
// must keep working with manual entry so a missing API key never breaks
// the order flow.

export type AddressProvider =
  | "mapbox"
  | "google"
  | "getaddress"
  | "postcodes_io" // free, no-key UK postcode lookup — returns town/county only
  | "manual";

export interface AddressSuggestion {
  id: string;
  label: string; // human-readable full address for the UI list
  line1: string;
  line2?: string;
  city?: string;
  postcode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  provider: AddressProvider;
}

export interface AddressLookupResult {
  provider: AddressProvider;
  suggestions: AddressSuggestion[];
}

export interface ProviderStatus {
  /** Which autocomplete provider would handle a free-text search */
  searchProvider: AddressProvider;
  /** Which postcode lookup provider would handle a UK-postcode lookup */
  postcodeProvider: AddressProvider;
}

@Injectable()
export class AddressLookupService {
  private readonly logger = new Logger(AddressLookupService.name);

  private get mapboxToken(): string | undefined {
    return process.env.MAPBOX_ACCESS_TOKEN;
  }

  private get googleKey(): string | undefined {
    return process.env.GOOGLE_MAPS_API_KEY;
  }

  private get getAddressKey(): string | undefined {
    return process.env.GETADDRESS_API_KEY;
  }

  /** Which provider would handle free-text autocomplete right now?
   *  Google is preferred over Mapbox when both are set — its $200/month
   *  free credit covers normal POS volumes, and UK addresses are richer. */
  describeActiveProvider(): AddressProvider {
    if (this.googleKey) return "google";
    if (this.mapboxToken) return "mapbox";
    return "manual";
  }

  /** Full provider status for the UI — separate autocomplete vs postcode-
   *  lookup providers because they're different services with different
   *  cost models (Mapbox is cheap autocomplete, getaddress.io is the
   *  Royal Mail PAF postcode lookup). */
  status(): ProviderStatus {
    return {
      searchProvider: this.describeActiveProvider(),
      // getaddress.io (PAF) is the full per-house lookup; postcodes.io is a
      // free no-key fallback that at least pre-fills town + county so the
      // operator can finish the address by hand.
      postcodeProvider: this.getAddressKey ? "getaddress" : "postcodes_io",
    };
  }

  async search(
    query: string,
    country: string = "gb",
    limit: number = 5,
  ): Promise<AddressLookupResult> {
    const trimmed = (query ?? "").trim();
    if (trimmed.length < 2) {
      return { provider: this.describeActiveProvider(), suggestions: [] };
    }

    // Google preferred — its $200/month free credit covers normal POS
    // volumes and its UK address coverage is richer than Mapbox.
    if (this.googleKey) {
      try {
        return await this.searchGoogle(trimmed, country, limit);
      } catch (err: any) {
        this.logger.warn(`Google lookup failed: ${err.message} — falling back`);
      }
    }

    if (this.mapboxToken) {
      try {
        return await this.searchMapbox(trimmed, country, limit);
      } catch (err: any) {
        this.logger.warn(`Mapbox lookup failed: ${err.message} — falling back`);
      }
    }

    // Manual fallback: no remote suggestions, the UI shows a plain form.
    return { provider: "manual", suggestions: [] };
  }

  /**
   * Google Places Autocomplete (legacy endpoint, simpler than the New
   * Places API). Returns lightweight predictions — the operator picks one,
   * then the frontend calls /v1/address-lookup/details?id=<place_id> to
   * resolve the full address. This two-step flow matches Google's billing
   * model (autocomplete sessions are cheap; details are the expensive bit
   * but only fire once per finished address).
   */
  private async searchGoogle(
    query: string,
    country: string,
    limit: number,
  ): Promise<AddressLookupResult> {
    const url =
      `https://maps.googleapis.com/maps/api/place/autocomplete/json` +
      `?input=${encodeURIComponent(query)}` +
      `&key=${this.googleKey}` +
      `&components=country:${country}` +
      `&types=address`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Google autocomplete ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      status: string;
      predictions?: Array<{
        place_id: string;
        description: string;
        structured_formatting?: {
          main_text?: string;
          secondary_text?: string;
        };
      }>;
      error_message?: string;
    };
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      throw new Error(
        `Google autocomplete: ${data.status}` +
          (data.error_message ? ` — ${data.error_message}` : ""),
      );
    }

    const suggestions: AddressSuggestion[] = (data.predictions ?? [])
      .slice(0, limit)
      .map((p) => ({
        // The id IS the place_id — the frontend hands this back to
        // /address-lookup/details to resolve the full address.
        id: p.place_id,
        label: p.description,
        // Best-effort split of the autocomplete label until details resolve:
        line1: p.structured_formatting?.main_text ?? p.description,
        provider: "google",
      }));

    return { provider: "google", suggestions };
  }

  /**
   * Resolve a Google place_id to a full structured address. Called from
   * the frontend when the operator picks an autocomplete suggestion.
   * Returns null when the id is unknown / Google returns no result.
   */
  async getPlaceDetails(placeId: string): Promise<AddressSuggestion | null> {
    if (!this.googleKey) return null;
    if (!placeId) return null;

    const url =
      `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(placeId)}` +
      `&key=${this.googleKey}` +
      // Only the bits the cart panel needs — keeps the bill down.
      `&fields=address_component,formatted_address,geometry`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Google details ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      status: string;
      result?: {
        formatted_address?: string;
        address_components?: Array<{
          long_name: string;
          short_name: string;
          types: string[];
        }>;
        geometry?: { location?: { lat: number; lng: number } };
      };
      error_message?: string;
    };
    if (data.status !== "OK" || !data.result) {
      return null;
    }

    return mapGooglePlaceDetails(placeId, data.result);
  }

  private async searchMapbox(
    query: string,
    country: string,
    limit: number,
  ): Promise<AddressLookupResult> {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${this.mapboxToken}` +
      `&country=${country}` +
      `&types=address,postcode` +
      `&autocomplete=true` +
      `&limit=${limit}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Mapbox ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      features: Array<{
        id: string;
        place_name: string;
        text: string;
        address?: string;
        context?: Array<{ id: string; text: string }>;
        center?: [number, number];
        properties?: { accuracy?: string };
      }>;
    };

    const suggestions: AddressSuggestion[] = data.features.map((feat) => {
      const ctx = feat.context ?? [];
      const findCtx = (idPrefix: string) =>
        ctx.find((c) => c.id.startsWith(idPrefix))?.text;
      return {
        id: feat.id,
        label: feat.place_name,
        line1: feat.address ? `${feat.address} ${feat.text}` : feat.text,
        city: findCtx("place"),
        postcode: findCtx("postcode"),
        country: findCtx("country"),
        latitude: feat.center?.[1],
        longitude: feat.center?.[0],
        provider: "mapbox",
      };
    });

    return { provider: "mapbox", suggestions };
  }

  /**
   * Look up the full address list at a UK postcode.
   *
   * Uses getaddress.io (Royal Mail PAF) when `GETADDRESS_API_KEY` is set —
   * the canonical UK source, ≈£0.005/lookup with a free dev tier. Returns
   * an empty list when no provider is configured so the UI can still fall
   * back to manual entry without surfacing an error.
   *
   * The endpoint accepts both formats — "SW1A 1AA" and "SW1A1AA". We
   * normalise to no-whitespace because getaddress.io's path is forgiving
   * either way.
   */
  async searchByPostcode(postcodeRaw: string): Promise<AddressLookupResult> {
    const postcode = (postcodeRaw ?? "").toUpperCase().replace(/\s+/g, "");
    if (postcode.length < 5) {
      return { provider: this.getAddressKey ? "getaddress" : "manual", suggestions: [] };
    }

    if (this.getAddressKey) {
      try {
        return await this.searchGetAddress(postcode);
      } catch (err: any) {
        this.logger.warn(`getaddress.io lookup failed: ${err.message}`);
      }
    }

    // No paid provider — fall back to postcodes.io (free, no API key
    // required). It can't enumerate individual houses but it WILL validate
    // the postcode and return the town/county/region, which the operator
    // can then complete with the house number.
    try {
      return await this.searchPostcodesIo(postcode);
    } catch (err: any) {
      this.logger.warn(`postcodes.io lookup failed: ${err.message}`);
    }

    return { provider: "manual", suggestions: [] };
  }

  /**
   * Free no-key fallback via postcodes.io. Returns a single stub address
   * with line1 empty (for the operator to type the house number) and
   * city/county/postcode pre-filled so the cart panel still saves the
   * operator most of the typing.
   */
  private async searchPostcodesIo(postcode: string): Promise<AddressLookupResult> {
    const res = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`,
    );
    if (res.status === 404) {
      // Not a valid UK postcode.
      return { provider: "postcodes_io", suggestions: [] };
    }
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
        region?: string;
        country?: string;
        latitude?: number;
        longitude?: number;
      };
    };
    if (!data.result) {
      return { provider: "postcodes_io", suggestions: [] };
    }

    const r = data.result;
    const city = r.admin_district ?? r.admin_ward ?? r.parish ?? "";
    const label = [city, r.postcode].filter(Boolean).join(", ");

    return {
      provider: "postcodes_io",
      suggestions: [
        {
          id: `postcodes_io:${r.postcode}`,
          // Make it obvious the operator still has to type the building.
          label: `${label} — add house/flat number`,
          line1: "",
          city,
          postcode: r.postcode,
          country: r.country ?? "GB",
          latitude: r.latitude,
          longitude: r.longitude,
          provider: "postcodes_io",
        },
      ],
    };
  }

  private async searchGetAddress(postcode: string): Promise<AddressLookupResult> {
    // expand=true returns structured line_1..line_4 + locality + town +
    // county + postcode + lat/lng per address. Without it you get a
    // single comma-joined string which we'd have to re-parse.
    const url =
      `https://api.getaddress.io/find/${encodeURIComponent(postcode)}` +
      `?api-key=${this.getAddressKey}&expand=true`;

    const res = await fetch(url);
    if (res.status === 404) {
      // Postcode is valid format but no addresses found — surface an empty
      // list so the UI can show "no addresses for this postcode" instead
      // of "lookup failed".
      return { provider: "getaddress", suggestions: [] };
    }
    if (!res.ok) {
      throw new Error(`getaddress.io ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      latitude?: number;
      longitude?: number;
      postcode?: string;
      addresses: Array<{
        formatted_address?: string[];
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
      data.postcode ??
      // Re-pretty-print: insert space before the inward 3 chars
      `${postcode.slice(0, -3)} ${postcode.slice(-3)}`;

    const suggestions: AddressSuggestion[] = (data.addresses ?? []).map(
      (a, idx) => {
        const line1 = a.line_1?.trim() || "";
        const line2 = [a.line_2, a.line_3, a.line_4]
          .map((s) => (s ?? "").trim())
          .filter(Boolean)
          .join(", ");
        const town = a.town_or_city ?? a.locality ?? "";
        const label = [line1, line2, town, formattedPostcode]
          .filter(Boolean)
          .join(", ");
        return {
          id: `getaddress:${postcode}:${idx}`,
          label,
          line1,
          line2: line2 || undefined,
          city: town || undefined,
          postcode: formattedPostcode,
          country: a.country ?? "GB",
          latitude: a.latitude ?? data.latitude,
          longitude: a.longitude ?? data.longitude,
          provider: "getaddress",
        };
      },
    );

    return { provider: "getaddress", suggestions };
  }
}

/**
 * Translate a Google Places Details result into our AddressSuggestion shape.
 * Google returns address parts as a tagged components array — we pluck the
 * tags we care about and assemble line1 from street_number + route.
 */
function mapGooglePlaceDetails(
  placeId: string,
  result: {
    formatted_address?: string;
    address_components?: Array<{
      long_name: string;
      short_name: string;
      types: string[];
    }>;
    geometry?: { location?: { lat: number; lng: number } };
  },
): AddressSuggestion {
  const components = result.address_components ?? [];
  const pick = (type: string): string | undefined =>
    components.find((c) => c.types.includes(type))?.long_name;
  const pickShort = (type: string): string | undefined =>
    components.find((c) => c.types.includes(type))?.short_name;

  const streetNumber = pick("street_number");
  const route = pick("route");
  const subpremise = pick("subpremise"); // flat / unit number when Google has it
  const line1Parts = [streetNumber, route].filter(Boolean);
  const line1 = line1Parts.join(" ");
  const line2 = subpremise ? `Flat ${subpremise}` : undefined;

  const city =
    pick("postal_town") ?? pick("locality") ?? pick("administrative_area_level_2");
  const postcode = pick("postal_code");
  const country = pickShort("country");

  return {
    id: placeId,
    label: result.formatted_address ?? [line1, city, postcode].filter(Boolean).join(", "),
    line1: line1 || (result.formatted_address ?? ""),
    line2,
    city,
    postcode,
    country,
    latitude: result.geometry?.location?.lat,
    longitude: result.geometry?.location?.lng,
    provider: "google",
  };
}

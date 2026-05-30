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

export type AddressProvider = "mapbox" | "google" | "getaddress" | "manual";

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

  /** Which provider would handle free-text autocomplete right now? */
  describeActiveProvider(): AddressProvider {
    if (this.mapboxToken) return "mapbox";
    if (this.googleKey) return "google";
    return "manual";
  }

  /** Full provider status for the UI — separate autocomplete vs postcode-
   *  lookup providers because they're different services with different
   *  cost models (Mapbox is cheap autocomplete, getaddress.io is the
   *  Royal Mail PAF postcode lookup). */
  status(): ProviderStatus {
    return {
      searchProvider: this.describeActiveProvider(),
      postcodeProvider: this.getAddressKey ? "getaddress" : "manual",
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

    // No provider configured (or remote failed) — let the UI fall back to
    // manual entry.
    return { provider: "manual", suggestions: [] };
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

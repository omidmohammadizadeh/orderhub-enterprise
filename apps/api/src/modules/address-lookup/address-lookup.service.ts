import { Injectable, Logger } from "@nestjs/common";

// Phase AM — Address lookup provider abstraction.
//
// Three providers possible:
//   1. Mapbox — gated on MAPBOX_ACCESS_TOKEN env var
//   2. Google Places — gated on GOOGLE_MAPS_API_KEY (placeholder, not implemented)
//   3. Manual — always available, returns empty suggestions; the UI falls
//      back to free-text input on the cart panel.
//
// We deliberately do not throw when no provider is configured — the POS
// must keep working with manual entry so a missing API key never breaks
// the order flow.

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
  provider: "mapbox" | "google" | "manual";
}

export interface AddressLookupResult {
  provider: "mapbox" | "google" | "manual";
  suggestions: AddressSuggestion[];
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

  /** Which provider would handle a search right now? Useful for the UI to
   *  decide between "search box" vs "manual entry" hints. */
  describeActiveProvider(): "mapbox" | "google" | "manual" {
    if (this.mapboxToken) return "mapbox";
    if (this.googleKey) return "google";
    return "manual";
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
}

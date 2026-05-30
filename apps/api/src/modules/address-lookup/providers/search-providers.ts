// Phase AM — Free-text address autocomplete providers.
//
// Each class implements SearchProvider. The service iterates a chain
// constructed in the module and dispatches to the first provider whose
// isConfigured() returns true.

import { Logger } from "@nestjs/common";
import type {
  AddressSuggestion,
  SearchProvider,
} from "./types";

// ── Google Places (preferred when GOOGLE_MAPS_API_KEY is set) ───────────────
//
// Two-step flow: autocomplete returns predictions with `place_id`, the
// caller follows up with getDetails(id) when the operator picks one.
// Matches Google's session-token billing — autocomplete is cheap, details
// is the expensive bit but only fires once per finished address.
export class GoogleSearchProvider implements SearchProvider {
  readonly id = "google" as const;
  private readonly logger = new Logger(GoogleSearchProvider.name);

  isConfigured(): boolean {
    return !!process.env.GOOGLE_MAPS_API_KEY;
  }

  async search(
    query: string,
    country: string,
    limit: number,
  ): Promise<AddressSuggestion[]> {
    const key = process.env.GOOGLE_MAPS_API_KEY!;
    const url =
      `https://maps.googleapis.com/maps/api/place/autocomplete/json` +
      `?input=${encodeURIComponent(query)}` +
      `&key=${key}` +
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
        structured_formatting?: { main_text?: string; secondary_text?: string };
      }>;
      error_message?: string;
    };
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      throw new Error(
        `Google: ${data.status}${data.error_message ? ` — ${data.error_message}` : ""}`,
      );
    }
    return (data.predictions ?? []).slice(0, limit).map((p) => ({
      id: p.place_id,
      label: p.description,
      line1: p.structured_formatting?.main_text ?? p.description,
      provider: "google" as const,
    }));
  }

  async getDetails(placeId: string): Promise<AddressSuggestion | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key || !placeId) return null;
    const url =
      `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(placeId)}` +
      `&key=${key}` +
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
    };
    if (data.status !== "OK" || !data.result) return null;
    return mapGooglePlaceDetails(placeId, data.result);
  }
}

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
  const subpremise = pick("subpremise");
  const line1 = [streetNumber, route].filter(Boolean).join(" ");
  const city =
    pick("postal_town") ?? pick("locality") ?? pick("administrative_area_level_2");

  return {
    id: placeId,
    label: result.formatted_address ?? [line1, city, pick("postal_code")].filter(Boolean).join(", "),
    line1: line1 || (result.formatted_address ?? ""),
    line2: subpremise ? `Flat ${subpremise}` : undefined,
    city,
    postcode: pick("postal_code"),
    country: pickShort("country"),
    latitude: result.geometry?.location?.lat,
    longitude: result.geometry?.location?.lng,
    provider: "google",
  };
}

// ── Mapbox (fallback when MAPBOX_ACCESS_TOKEN is set) ───────────────────────
//
// One-shot — Mapbox returns fully-structured addresses inline so no
// getDetails step is needed.
export class MapboxSearchProvider implements SearchProvider {
  readonly id = "mapbox" as const;

  isConfigured(): boolean {
    return !!process.env.MAPBOX_ACCESS_TOKEN;
  }

  async search(
    query: string,
    country: string,
    limit: number,
  ): Promise<AddressSuggestion[]> {
    const token = process.env.MAPBOX_ACCESS_TOKEN!;
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${token}` +
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
      }>;
    };
    return data.features.map((feat) => {
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
        provider: "mapbox" as const,
      };
    });
  }
}

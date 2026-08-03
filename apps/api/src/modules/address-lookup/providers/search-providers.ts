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
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": key,
      },
      body: JSON.stringify({
        input: query,
        includedRegionCodes: [country.toLowerCase()],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Google autocomplete ${res.status} ${res.statusText}${
          text ? ` — ${text.slice(0, 200)}` : ""
        }`,
      );
    }
    const data = (await res.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }>;
    };
    // No matches is an empty body here, not an error — the legacy API's
    // ZERO_RESULTS status has no equivalent in Places (New).
    return (data.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
      .slice(0, limit)
      .map((p) => ({
        id: p.placeId!,
        label: p.text?.text ?? p.structuredFormat?.mainText?.text ?? "",
        line1: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
        provider: "google" as const,
      }));
  }

  async getDetails(placeId: string): Promise<AddressSuggestion | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key || !placeId) return null;
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": key,
          // Places (New) bills by the fields you ask for, so ask for exactly
          // the three we map and nothing else.
          "X-Goog-FieldMask": "addressComponents,formattedAddress,location",
        },
      },
    );
    if (!res.ok) {
      throw new Error(`Google details ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as GooglePlaceNew;
    if (!data) return null;
    return mapGooglePlaceDetails(placeId, data);
  }
}

/** Places API (New) response shape. The field names differ from the legacy
 *  API in ways that silently produce blank addresses if you assume the old
 *  ones: longText/shortText rather than long_name/short_name, and a flat
 *  `location` rather than geometry.location. */
interface GooglePlaceNew {
  formattedAddress?: string;
  addressComponents?: Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
  }>;
  location?: { latitude?: number; longitude?: number };
}

function mapGooglePlaceDetails(
  placeId: string,
  result: GooglePlaceNew,
): AddressSuggestion {
  const components = result.addressComponents ?? [];
  const pick = (type: string): string | undefined =>
    components.find((c) => c.types?.includes(type))?.longText;
  const pickShort = (type: string): string | undefined =>
    components.find((c) => c.types?.includes(type))?.shortText;

  const streetNumber = pick("street_number");
  const route = pick("route");
  const subpremise = pick("subpremise");
  const line1 = [streetNumber, route].filter(Boolean).join(" ");
  const city =
    pick("postal_town") ?? pick("locality") ?? pick("administrative_area_level_2");

  return {
    id: placeId,
    label:
      result.formattedAddress ??
      [line1, city, pick("postal_code")].filter(Boolean).join(", "),
    line1: line1 || (result.formattedAddress ?? ""),
    line2: subpremise ? `Flat ${subpremise}` : undefined,
    city,
    postcode: pick("postal_code"),
    country: pickShort("country"),
    latitude: result.location?.latitude,
    longitude: result.location?.longitude,
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

import { Injectable, Logger } from "@nestjs/common";

export interface GeoPoint {
  lat: number;
  lng: number;
}

// Phase AX — server-side geocoding for the dispatch map. Reuses the existing
// GOOGLE_MAPS_API_KEY (the server key, NOT referrer-restricted). Soft-fails to
// null whenever the key is missing or the address can't be resolved, so a bad
// address never blocks order ingest or the dispatch feed.
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  /**
   * @param country ISO-2 country to bias the search to. Defaults to GB for
   * callers that predate multi-country, but a UAE order geocoded as GB returns
   * nothing at all — the whole address is in the wrong country — so a Dubai
   * delivery simply never got a map pin.
   */
  async geocode(
    address: string | null | undefined,
    country: string | null | undefined = "GB",
  ): Promise<GeoPoint | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      this.logger.warn("GOOGLE_MAPS_API_KEY not set — skipping geocode");
      return null;
    }
    const query = (address ?? "").trim();
    if (!query) return null;

    try {
      const cc = String(country ?? "GB").trim().toUpperCase() || "GB";
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json` +
        `?address=${encodeURIComponent(query)}` +
        `&region=${encodeURIComponent(cc.toLowerCase())}` +
        `&components=country:${encodeURIComponent(cc)}&key=${key}`;
      const res = await fetch(url);
      if (!res.ok) {
        this.logger.warn(`Geocode HTTP ${res.status} for "${query}"`);
        return null;
      }
      const data = (await res.json()) as {
        status?: string;
        results?: Array<{
          geometry?: { location?: { lat: number; lng: number } };
        }>;
      };
      if (data.status !== "OK" || !data.results?.length) {
        this.logger.debug(`Geocode status=${data.status ?? "?"} for "${query}"`);
        return null;
      }
      const loc = data.results[0]?.geometry?.location;
      if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
        return null;
      }
      return { lat: loc.lat, lng: loc.lng };
    } catch (err) {
      this.logger.warn(
        `Geocode failed for "${query}": ${(err as Error).message}`,
      );
      return null;
    }
  }
}

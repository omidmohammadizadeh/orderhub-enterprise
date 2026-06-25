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

  async geocode(address: string | null | undefined): Promise<GeoPoint | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      this.logger.warn("GOOGLE_MAPS_API_KEY not set — skipping geocode");
      return null;
    }
    const query = (address ?? "").trim();
    if (!query) return null;

    try {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json` +
        `?address=${encodeURIComponent(query)}` +
        `&region=gb&components=country:GB&key=${key}`;
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

// Phase AM — UK postcode → addresses providers.
//
// Two are wired today (getaddress.io paid, postcodes.io free) and three
// vendor adapters are stubbed so the next phase can light them up by
// just dropping in their HTTP calls. Each stub throws a clear "not
// configured" error from searchByPostcode so the provider chain in
// AddressLookupService falls through cleanly.

import { Logger } from "@nestjs/common";
import { cacheStreets, getCachedStreets, type CachedStreets } from "./postcode-street-cache";
import type { AddressSuggestion, PostcodeProvider } from "./types";

/** Google is a paid, datacentre-grade endpoint — it either answers fast or is
 *  misconfigured, so the deadline is short on purpose. */
const GOOGLE_TIMEOUT_MS = Number(process.env.ADDRESS_GOOGLE_TIMEOUT_MS) || 2500;

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

// ── Google Geocoding (postcode → street names) ─────────────────────────────
//
// The free OSM chain below is the right default for a POS: an operator can
// wait a second and can read a list. A phone caller can do neither, and the
// endpoints it depends on are volunteer-run — from Render's outbound IPs
// overpass-api.de fails to connect outright ("fetch failed", not a timeout),
// which leaves the voice line asking for a street it should already know.
//
// Google is reachable from any datacentre, answers in ~150ms, and the account
// is already open for the dispatch map. Set GOOGLE_MAPS_API_KEY on the API
// service (a SERVER key — IP/API restricted, not the referrer-restricted
// browser key the web app uses) and this takes over from OSM.
//
// Two calls at most:
//   1. Geocode the postcode → centroid, postal_town, and for small postcodes
//      often the route itself.
//   2. Only if step 1 named no route: reverse-geocode the centroid, which
//      does.
export class GooglePostcodeProvider implements PostcodeProvider {
  readonly id = "google" as const;
  private readonly logger = new Logger(GooglePostcodeProvider.name);

  isConfigured(): boolean {
    return !!process.env.GOOGLE_MAPS_API_KEY;
  }

  async searchByPostcode(postcode: string): Promise<AddressSuggestion[]> {
    const pretty = `${postcode.slice(0, -3)} ${postcode.slice(-3)}`;

    const cached = getCachedStreets(postcode);
    if (cached) return this.toSuggestions(postcode, pretty, cached);

    const key = process.env.GOOGLE_MAPS_API_KEY!;
    const geo = await this.fetchJson(
      `https://maps.googleapis.com/maps/api/geocode/json` +
        `?address=${encodeURIComponent(pretty)}` +
        `&components=country:GB&key=${key}`,
    );
    if (geo?.status === "ZERO_RESULTS") return [];
    if (geo?.status && geo.status !== "OK") {
      // Surfacing this matters: a billing-disabled or wrongly-restricted key
      // fails silently otherwise and the line quietly drops to asking for the
      // street by voice for weeks.
      throw new Error(`google geocode ${geo.status}${geo.error_message ? `: ${geo.error_message}` : ""}`);
    }

    const results: GoogleResult[] = geo?.results ?? [];
    const first = results[0];
    const loc = first?.geometry?.location;
    if (!loc) return [];

    const city = pickComponent(results, ["postal_town", "locality", "administrative_area_level_2"]);
    let streets = collectRoutes(results);

    if (!streets.length) {
      const rev = await this.fetchJson(
        `https://maps.googleapis.com/maps/api/geocode/json` +
          `?latlng=${loc.lat},${loc.lng}` +
          `&result_type=street_address|route|premise&key=${key}`,
      );
      if (rev?.status && rev.status !== "OK" && rev.status !== "ZERO_RESULTS") {
        this.logger.warn(`google reverse ${rev.status}`);
      }
      streets = collectRoutes(rev?.results ?? []);
    }

    if (!streets.length) return [];

    const value = { streets, city, latitude: loc.lat, longitude: loc.lng };
    cacheStreets(postcode, value);
    return this.toSuggestions(postcode, pretty, value);
  }

  private async fetchJson(url: string): Promise<any> {
    const res = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`google geocode HTTP ${res.status} ${res.statusText}`);
    return res.json();
  }

  private toSuggestions(
    postcode: string,
    pretty: string,
    value: CachedStreets,
  ): AddressSuggestion[] {
    return value.streets.map((street, idx) => ({
      id: `google:${postcode}:${idx}`,
      label: `${street}${value.city ? `, ${value.city}` : ""}, ${pretty} — add house/flat`,
      line1: street,
      city: value.city || undefined,
      postcode: pretty,
      country: "GB",
      latitude: value.latitude,
      longitude: value.longitude,
      provider: "google" as const,
    }));
  }
}

interface GoogleResult {
  address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
  geometry?: { location?: { lat: number; lng: number } };
}

/** Distinct route (street) names across a Google geocode response, in order. */
function collectRoutes(results: GoogleResult[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    for (const c of r.address_components ?? []) {
      if (!c.types?.includes("route")) continue;
      const name = c.long_name?.trim();
      if (!name) continue;
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
  }
  return out;
}

function pickComponent(results: GoogleResult[], types: string[]): string | undefined {
  for (const type of types) {
    for (const r of results) {
      for (const c of r.address_components ?? []) {
        if (c.types?.includes(type) && c.long_name?.trim()) return c.long_name.trim();
      }
    }
  }
  return undefined;
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
/** How long either free geocoder gets before we move on. */
const OVERPASS_TIMEOUT_MS = Number(process.env.ADDRESS_OVERPASS_TIMEOUT_MS) || 1500;
const NOMINATIM_TIMEOUT_MS = Number(process.env.ADDRESS_NOMINATIM_TIMEOUT_MS) || 1500;

/** Overpass is volunteer-run and the main instance is not reachable from every
 *  network — Render's outbound IPs can't connect to overpass-api.de at all.
 *  The mirrors run the same API, so ask more than one and take whoever
 *  answers. Override with a comma-separated ADDRESS_OVERPASS_ENDPOINTS. */
const OVERPASS_ENDPOINTS: string[] = (
  process.env.ADDRESS_OVERPASS_ENDPOINTS ??
  "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Run every task at once and resolve with the first NON-EMPTY result.
 *
 * Promise.any is the wrong shape here: these tasks signal failure by
 * resolving empty, not by rejecting, so any() would hand back the first
 * shrug. Resolves [] if the deadline passes or everything comes back empty.
 */
export async function firstNonEmpty<T>(
  tasks: Array<() => Promise<T[]>>,
  deadlineMs: number,
): Promise<T[]> {
  if (!tasks.length) return [];
  return new Promise<T[]>((resolve) => {
    let settled = false;
    let outstanding = tasks.length;
    const done = (value: T[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done([]), deadlineMs);
    // Nothing should keep the process alive waiting on a street name.
    (timer as any).unref?.();
    for (const task of tasks) {
      Promise.resolve()
        .then(task)
        .then((result) => {
          if (result?.length) done(result);
        })
        .catch(() => undefined)
        .finally(() => {
          outstanding -= 1;
          if (outstanding === 0) done([]);
        });
    }
  });
}

export class OsmStreetsProvider implements PostcodeProvider {
  readonly id = "osm" as const;
  private readonly logger = new Logger(OsmStreetsProvider.name);

  isConfigured(): boolean {
    return process.env.ADDRESS_LOOKUP_DISABLE_OSM !== "true";
  }

  private userAgent(): string {
    return (
      process.env.ADDRESS_LOOKUP_USER_AGENT ??
      "OrderHub-POS/1.0 (+https://orderhub.io; admin@orderhub.io)"
    );
  }

  async searchByPostcode(postcode: string): Promise<AddressSuggestion[]> {
    // Re-pretty the postcode (postcodes.io is tolerant either way).
    const pretty = `${postcode.slice(0, -3)} ${postcode.slice(-3)}`;

    const cached = getCachedStreets(postcode);
    if (cached) {
      return cached.streets.map((street, idx) => ({
        id: `osm:${postcode}:${idx}`,
        label: `${street}${cached.city ? `, ${cached.city}` : ""}, ${pretty} — add house/flat`,
        line1: street,
        city: cached.city || undefined,
        postcode: pretty,
        country: "GB",
        latitude: cached.latitude,
        longitude: cached.longitude,
        provider: "osm" as const,
      }));
    }

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
    // postcodes.io knows the local AUTHORITY, not the post town: NE37 2LL comes
    // back "Sunderland", and everybody who lives there calls it Washington.
    // A ward named "<Town> North/South/East/West/Central" is naming its town,
    // which recovers the post town for free and often enough to be worth it.
    const wardTown = (() => {
      const ward = pio.result.admin_ward ?? "";
      const m = ward.match(/^(.+?)\s+(north|south|east|west|central)(?:\s+\w+)?$/i);
      return m?.[1]?.trim() ?? "";
    })();
    const town =
      wardTown ||
      pio.result.admin_district ||
      pio.result.admin_ward ||
      pio.result.parish ||
      "";
    const postcodeOut = pio.result.postcode;

    // Step 2 — name the streets around those coords.
    //
    // These used to run one after the other: Overpass, and only once it had
    // given up, Nominatim. That ordering cannot work on a phone call.
    // overpass-api.de doesn't merely time out from Render's outbound IPs, it
    // fails to connect at all, and the Nominatim fallback then started from
    // zero with the caller's patience already spent — so the fallback never
    // once reached the caller. Ask all of them at the same time and take the
    // first real answer instead; the loser costs nothing.
    const found = await firstNonEmpty<{ street: string; town?: string }>(
      [
        ...OVERPASS_ENDPOINTS.map((endpoint) => () =>
          this.tryOverpass(latitude, longitude, endpoint),
        ),
        () => this.tryNominatim(latitude, longitude),
      ],
      OVERPASS_TIMEOUT_MS + 400,
    );
    const streets = found.map((f) => f.street);
    // postcodes.io gives the local AUTHORITY — "Sunderland" for a postcode
    // everybody who lives there calls Washington. When a geocoder knows the
    // actual post town, it is the one to read back to a caller.
    const postTown = found.find((f) => f.town)?.town ?? town;
    if (streets.length > 0) {
      cacheStreets(postcode, { streets, city: postTown || undefined, latitude, longitude });
      return streets.map((street, idx) => ({
        id: `osm:${postcode}:${idx}`,
        label: `${street}${postTown ? `, ${postTown}` : ""}, ${postcodeOut} — add house/flat`,
        line1: street,
        city: postTown || undefined,
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
  private async tryOverpass(
    lat: number,
    lng: number,
    endpoint: string,
  ): Promise<Array<{ street: string }>> {
    try {
      // The query's own timeout used to be 25s — pointless when the client
      // gives up in under two, and it makes the mirror hold a worker open on
      // our behalf after we've stopped listening.
      const query =
        `[out:json][timeout:5];` +
        `way["highway"]["name"](around:250,${lat},${lng});` +
        `out tags;`;
      const overpassUrl = `${endpoint}?data=${encodeURIComponent(query)}`;
      const opRes = await fetch(overpassUrl, {
        // The query asks Overpass for up to 25 seconds. Nothing was limiting
        // the CLIENT, so a slow day there became a slow day on a phone call —
        // and the Nominatim fallback below never got its turn inside the
        // caller's patience. Fail fast and let the fallback run.
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
        headers: { "User-Agent": this.userAgent() },
      });
      if (!opRes.ok) {
        this.logger.warn(`Overpass ${endpoint} ${opRes.status} ${opRes.statusText}`);
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
      return streets.map((street) => ({ street }));
    } catch (err: any) {
      this.logger.warn(`Overpass ${endpoint} exception: ${err?.message ?? err}`);
      return [];
    }
  }

  /**
   * Nominatim reverse geocode at the postcode centroid.
   *
   * This used to walk five jittered points to collect several road names, each
   * behind a 1.1s policy gap — four and a half seconds of deliberate waiting
   * before the first word could be spoken. OSM's usage policy caps us at one
   * request a second, so the honest conclusion is that Nominatim gets ONE
   * call here and names the likeliest street. The caller confirms it out loud
   * anyway, which is what the extra four points were really buying.
   */
  private async tryNominatim(
    lat: number,
    lng: number,
  ): Promise<Array<{ street: string; town?: string }>> {
    try {
      await this.throttleNominatim();
      const url =
        `https://nominatim.openstreetmap.org/reverse` +
        `?lat=${lat}&lon=${lng}&format=jsonv2&addressdetails=1&zoom=17`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
        headers: { "User-Agent": this.userAgent() },
      });
      if (!res.ok) {
        this.logger.warn(`Nominatim reverse ${res.status} ${res.statusText}`);
        return [];
      }
      const data = (await res.json()) as {
        address?: {
          road?: string;
          pedestrian?: string;
          residential?: string;
          town?: string;
          village?: string;
          city?: string;
          suburb?: string;
        };
      };
      const a = data.address ?? {};
      const road = a.road ?? a.pedestrian ?? a.residential;
      const town = a.town ?? a.village ?? a.suburb ?? a.city;
      return road ? [{ street: road, town }] : [];
    } catch (err: any) {
      this.logger.warn(`Nominatim reverse exception: ${err?.message ?? err}`);
      return [];
    }
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

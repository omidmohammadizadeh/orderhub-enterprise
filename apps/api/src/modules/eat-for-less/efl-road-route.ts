// Eat For Less — the road a delivery takes, for the app's live map.
//
// Google's Routes API gives the streets from the shop to the door once per
// order; while the driver is on the road we place them on that line and work
// out what's left from it, so a 4-second poll costs nothing. Only when the
// driver leaves the line (a different way, a wrong turn) do we ask Google
// again, from where the driver is, at most once a minute.
//
// No GOOGLE_ROUTES_API_KEY, or Google failing: no road, and the app draws a
// straight line as before.

import { Logger } from "@nestjs/common";

export type LatLng = { lat: number; lng: number };

export type RoadRoute = {
  /** Shop (or driver) to door, along the streets. */
  points: LatLng[];
  distanceMeters: number;
  durationSeconds: number;
};

/** What's still to drive, from a driver's position on the road. */
export type RoadLeft = { metersLeft: number; secondsLeft: number; offRouteMeters: number };

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const KEEP_MS = 3 * 60 * 60 * 1000;
const REROUTE_AFTER_M = 150;
const REROUTE_GAP_MS = 60_000;
const MAX_KEPT = 2000;

/** Google's encoded polyline format (precision 5). */
export function decodePolyline(encoded: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < encoded.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && i < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

/** Metres on a local flat projection around `origin`: plenty for a town. */
function toXY(p: LatLng, origin: LatLng) {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return { x: (p.lng - origin.lng) * 111_320 * k, y: (p.lat - origin.lat) * 110_540 };
}

/** Where `p` falls on the road: how far along it and how far off it, in metres. */
export function placeOnRoad(points: LatLng[], p: LatLng): { along: number; total: number; off: number } {
  if (points.length < 2) return { along: 0, total: 0, off: Infinity };
  const o = points[0]!;
  const xy = points.map((q) => toXY(q, o));
  const me = toXY(p, o);
  let walked = 0;
  let best = { along: 0, off: Infinity };
  for (let i = 0; i < xy.length - 1; i++) {
    const a = xy[i]!;
    const b = xy[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const t = len ? Math.max(0, Math.min(1, ((me.x - a.x) * (b.x - a.x) + (me.y - a.y) * (b.y - a.y)) / (len * len))) : 0;
    const off = Math.hypot(me.x - (a.x + (b.x - a.x) * t), me.y - (a.y + (b.y - a.y) * t));
    if (off < best.off) best = { along: walked + t * len, off };
    walked += len;
  }
  return { ...best, total: walked };
}

/** Distance and time left from a driver's position, pro rata along the road. */
export function roadLeft(route: RoadRoute, driver: LatLng): RoadLeft {
  const { along, total, off } = placeOnRoad(route.points, driver);
  const fraction = total ? Math.max(0, 1 - along / total) : 1;
  return {
    metersLeft: Math.round(route.distanceMeters * fraction),
    secondsLeft: Math.round(route.durationSeconds * fraction),
    offRouteMeters: Math.round(off),
  };
}

type Kept = { route: RoadRoute; at: number; askedAt: number };

export class RoadRoutes {
  private readonly logger = new Logger(RoadRoutes.name);
  private readonly kept = new Map<string, Kept>();

  constructor(
    private readonly key: string | undefined = process.env.GOOGLE_ROUTES_API_KEY,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The road for one order. `driver` is the live position once it's on the
   * way: on the road it changes nothing, off it (past REROUTE_AFTER_M) it
   * re-asks Google from there.
   */
  async forOrder(orderId: string, from: LatLng, to: LatLng, driver?: LatLng | null): Promise<RoadRoute | null> {
    if (!this.key) return null;
    const now = this.now();
    const kept = this.kept.get(orderId);
    if (kept && now - kept.at < KEEP_MS) {
      const strayed = driver && placeOnRoad(kept.route.points, driver).off > REROUTE_AFTER_M;
      if (!strayed || now - kept.askedAt < REROUTE_GAP_MS) return kept.route;
      const fresh = await this.ask(driver!, to);
      if (!fresh) {
        kept.askedAt = now;
        return kept.route;
      }
      this.keep(orderId, { route: fresh, at: now, askedAt: now });
      return fresh;
    }
    const fresh = await this.ask(driver ?? from, to);
    if (fresh) this.keep(orderId, { route: fresh, at: now, askedAt: now });
    return fresh;
  }

  private keep(orderId: string, entry: Kept) {
    this.kept.delete(orderId);
    this.kept.set(orderId, entry);
    // Oldest first in a Map: trim from the front.
    while (this.kept.size > MAX_KEPT) this.kept.delete(this.kept.keys().next().value!);
  }

  private async ask(from: LatLng, to: LatLng): Promise<RoadRoute | null> {
    try {
      const res = await this.fetchImpl(ROUTES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.key!,
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
          destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Routes API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const body: any = await res.json();
      const r = body?.routes?.[0];
      const encoded = r?.polyline?.encodedPolyline;
      if (!encoded) return null;
      return {
        points: decodePolyline(encoded),
        distanceMeters: Number(r.distanceMeters ?? 0),
        // "523s"
        durationSeconds: parseInt(String(r.duration ?? "0"), 10) || 0,
      };
    } catch (err: any) {
      this.logger.warn(`Routes API failed: ${err?.message ?? err}`);
      return null;
    }
  }
}

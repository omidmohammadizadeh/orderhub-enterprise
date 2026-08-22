import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import {
  normalisePostcode,
  resolveRadiusBand,
  resolveZone,
  zoneMode,
  type DeliveryZoneMode,
  type ZoneMatch,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AM — DeliveryZone CRUD + fee lookup.
//
// The MATCHING is not here. It lives in @orderhub/shared (lib/delivery-zones)
// so the storefront runs byte-identical logic in the browser when it shows the
// fee before checkout. This service owns the I/O around it: tenant scoping,
// which rows apply, and geocoding for the radius mode.
//
// Three modes — postcode prefix, distance band, named area — described in the
// shared module. A zone set uses exactly one.

export { normalisePostcode, resolveRadiusBand };

const MODE_LABEL: Record<DeliveryZoneMode, string> = {
  AREA: "area",
  RADIUS: "distance",
  POSTCODE: "postcode",
  NONE: "nothing",
};

export interface CreateDeliveryZoneDto {
  locationId?: string;
  brandId?: string;
  /** Postcode mode. Exactly one of this, maxDistanceMiles or areaName. */
  postcodePrefix?: string;
  /** Radius mode — the outer edge of this band, in miles. */
  maxDistanceMiles?: number;
  /** Area mode — the named community this row prices, e.g. "Dubai Marina". */
  areaName?: string;
  fee: number;
  minOrderValue?: number;
  isActive?: boolean;
}

export interface UpdateDeliveryZoneDto {
  postcodePrefix?: string;
  maxDistanceMiles?: number | null;
  areaName?: string | null;
  fee?: number;
  minOrderValue?: number | null;
  isActive?: boolean;
}

export interface LookupResult {
  matched: boolean;
  /** Which model priced this — so the caller can label the fee correctly. */
  mode?: DeliveryZoneMode;
  zoneId?: string;
  postcodePrefix?: string;
  /** Area mode — the matched community. */
  areaName?: string;
  /** Human-readable zone label: "Dubai Marina", "SW1A", "0–3 mi". */
  label?: string;
  /** Area mode only — the shop does not deliver to the area given. Unlike a
   *  postcode miss this is a refusal, not a data gap to price around. */
  unserviceable?: boolean;
  fee: number;
  minOrderValue?: number | null;
  /** Radius mode only — how far the customer is, for the UI to show. */
  distanceMiles?: number;
  /** True when the address is past the furthest band and paying the top rate. */
  beyondLastBand?: boolean;
}

/**
 * Straight-line miles between two points.
 *
 * As-the-crow-flies, matching how Uber and Deliveroo draw their radius. It is
 * not driving distance — a customer two miles across the river can be a six
 * mile drive — but it costs nothing, answers instantly, and is what operators
 * are used to seeing on a map. Driving distance would mean a paid routing call
 * on every basket change.
 */
export function milesBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 3958.7613; // Earth radius in miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}


/** Shape the shared resolver's verdict into the wire response. Kept as a
 *  translation rather than returning ZoneMatch directly so the HTTP contract
 *  (which the POS and storefront both read) can stay stable while the resolver
 *  grows modes. */
function toLookupResult(m: ZoneMatch): LookupResult {
  return {
    matched: m.matched,
    mode: m.mode,
    ...(m.zoneId ? { zoneId: m.zoneId } : {}),
    ...(m.postcodePrefix ? { postcodePrefix: m.postcodePrefix } : {}),
    ...(m.areaName ? { areaName: m.areaName } : {}),
    ...(m.label ? { label: m.label } : {}),
    ...(m.unserviceable ? { unserviceable: true } : {}),
    fee: m.fee,
    minOrderValue: m.minOrderValue,
    ...(m.distanceMiles != null ? { distanceMiles: m.distanceMiles } : {}),
    ...(m.beyondLastBand ? { beyondLastBand: true } : {}),
  };
}

@Injectable()
export class DeliveryZonesService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }

  private async assertBrand(tenantId: string, brandId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");
  }

  async listForLocation(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    return this.prisma.deliveryZone.findMany({
      where: { locationId },
      orderBy: [
        { isActive: "desc" },
        { maxDistanceMiles: "asc" },
        { areaName: "asc" },
        { postcodePrefix: "asc" },
      ],
    });
  }

  async listForBrand(tenantId: string, brandId: string) {
    await this.assertBrand(tenantId, brandId);
    return this.prisma.deliveryZone.findMany({
      where: { brandId } as any,
      orderBy: [
        { isActive: "desc" },
        { maxDistanceMiles: "asc" },
        { areaName: "asc" },
        { postcodePrefix: "asc" },
      ],
    });
  }

  async create(tenantId: string, dto: CreateDeliveryZoneDto) {
    const prefix = normalisePostcode(dto.postcodePrefix ?? "");
    const radius = dto.maxDistanceMiles;
    const area = (dto.areaName ?? "").trim();
    // Exactly one. A row carrying two of them would match under two different
    // resolvers and quote two different fees depending on which ran.
    const given = [prefix ? 1 : 0, radius != null ? 1 : 0, area ? 1 : 0].reduce(
      (a, b) => a + b,
      0,
    );
    if (given > 1) {
      throw new BadRequestException(
        "A zone is a postcode prefix, a distance band or an area — not more than one",
      );
    }
    if (given === 0) {
      throw new BadRequestException(
        "postcodePrefix, maxDistanceMiles or areaName is required",
      );
    }
    if (radius != null && !(radius > 0)) {
      throw new BadRequestException("maxDistanceMiles must be greater than 0");
    }
    if (dto.fee < 0) throw new BadRequestException("fee must be ≥ 0");
    if (!dto.locationId && !dto.brandId) {
      throw new BadRequestException("locationId or brandId is required");
    }
    if (dto.locationId && dto.brandId) {
      throw new BadRequestException(
        "Provide either locationId or brandId, not both",
      );
    }
    if (dto.locationId) await this.assertLocation(tenantId, dto.locationId);
    if (dto.brandId) await this.assertBrand(tenantId, dto.brandId);

    // A zone SET uses one mode too, not just a zone row. Mixing them means the
    // resolver silently picks one by precedence and the operator's other rows
    // stop applying without anything saying so — which is exactly the failure
    // the editor's "remove all rows to switch mode" lock exists to prevent, and
    // the API is where that has to actually hold.
    const existing = await this.prisma.deliveryZone.findMany({
      where: dto.locationId
        ? { locationId: dto.locationId }
        : { brandId: dto.brandId! },
    });
    // Paused rows still count. zoneMode ignores them (a shop that paused its
    // only area row is not in area mode any more), but for THIS guard they
    // matter: allowing a postcode row alongside a paused area row just defers
    // the mixed set until someone unpauses it.
    const current = zoneMode(
      existing.map((z) => ({ ...z, isActive: true })) as any,
    );
    const incoming = area ? "AREA" : radius != null ? "RADIUS" : "POSTCODE";
    if (current !== "NONE" && current !== incoming) {
      throw new BadRequestException(
        `This ${dto.brandId ? "brand" : "location"} already charges by ${MODE_LABEL[current]}. Remove those rows before adding ${MODE_LABEL[incoming]} zones.`,
      );
    }

    return this.prisma.deliveryZone.create({
      data: {
        tenantId,
        locationId: dto.locationId ?? null,
        brandId: dto.brandId ?? null,
        postcodePrefix: prefix || null,
        maxDistanceMiles: radius ?? null,
        areaName: area || null,
        fee: dto.fee,
        minOrderValue: dto.minOrderValue ?? null,
        isActive: dto.isActive ?? true,
      } as any,
    });
  }

  async update(tenantId: string, id: string, dto: UpdateDeliveryZoneDto) {
    const zone = await this.prisma.deliveryZone.findFirst({
      where: { id, tenantId },
    });
    if (!zone) throw new NotFoundException("Delivery zone not found");

    return this.prisma.deliveryZone.update({
      where: { id },
      data: {
        ...(dto.postcodePrefix !== undefined && {
          postcodePrefix: normalisePostcode(dto.postcodePrefix) || null,
        }),
        ...(dto.maxDistanceMiles !== undefined && {
          maxDistanceMiles: dto.maxDistanceMiles,
        }),
        ...(dto.areaName !== undefined && {
          areaName: (dto.areaName ?? "").trim() || null,
        }),
        ...(dto.fee !== undefined && { fee: dto.fee }),
        ...(dto.minOrderValue !== undefined && { minOrderValue: dto.minOrderValue }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const zone = await this.prisma.deliveryZone.findFirst({
      where: { id, tenantId },
    });
    if (!zone) throw new NotFoundException("Delivery zone not found");
    await this.prisma.deliveryZone.delete({ where: { id } });
  }

  /**
   * Look up the delivery fee for one customer at this location.
   *
   * Takes whatever the caller knows — a postcode in the UK, a picked area in
   * the Gulf, coordinates when the address came from Places — and lets the
   * zone rows decide which of those actually prices the order.
   *
   * Returns { matched: false, fee: 0 } when nothing matches, and additionally
   * `unserviceable: true` when the customer named an area this shop does not
   * deliver to. The caller must treat those differently: the first is a data
   * gap to price around, the second is a refusal.
   */
  async lookup(
    tenantId: string,
    locationId: string,
    customer: { postcode?: string; area?: string; lat?: number; lng?: number },
  ): Promise<LookupResult> {
    await this.assertLocation(tenantId, locationId);

    const zones = await this.prisma.deliveryZone.findMany({
      where: { locationId, isActive: true },
    });
    if (!zones.length) return { matched: false, fee: 0, mode: "NONE" };

    // Distance is the one input the pure resolver can't work out for itself —
    // it needs a geocoder. Measure it only when the rows are actually distance
    // bands, so a postcode or area shop never pays for a geocode it ignores.
    let distanceMiles: number | null = null;
    if (zoneMode(zones as any) === "RADIUS") {
      distanceMiles = await this.measureDistance(
        tenantId,
        { locationId },
        customer,
      );
    }

    return toLookupResult(
      resolveZone(zones as any, {
        postcode: customer.postcode,
        area: customer.area,
        distanceMiles,
      }),
    );
  }

  /**
   * How far the customer is from the shop, in miles — or null when it can't be
   * measured.
   *
   * Prefers coordinates the caller already has (an address picked from Places
   * carries lat/lng) and otherwise geocodes what was typed. Null is deliberately
   * not zero: the resolver charges the top band when distance is unknown, which
   * is the safe direction to fail, and reading a failed geocode as "0 miles"
   * would give every unresolvable address the cheapest band instead.
   */
  /** Public so the storefront checkout can price a radius shop server-side.
   *  It gathers its own (deliberately wider) zone rows, but measuring distance
   *  needs the geocoding and the cached shop coordinates that live here. */
  async distanceMilesFor(
    tenantId: string,
    scope: { locationId?: string; brandId?: string },
    customer: { lat?: number; lng?: number; postcode?: string; area?: string },
  ): Promise<number | null> {
    return this.measureDistance(tenantId, scope, customer);
  }

  private async measureDistance(
    tenantId: string,
    scope: { locationId?: string; brandId?: string },
    customer: { lat?: number; lng?: number; postcode?: string; area?: string },
  ): Promise<number | null> {
    const origin = await this.originFor(tenantId, scope);
    if (!origin) return null;
    const point = await this.customerPoint(tenantId, scope, customer);
    if (!point) return null;
    return milesBetween(origin, point);
  }

  /** The shop's coordinates, geocoded from its own address on first use. */
  private async originFor(
    tenantId: string,
    scope: { locationId?: string; brandId?: string },
  ): Promise<{ lat: number; lng: number } | null> {
    let locationId = scope.locationId ?? null;
    if (!locationId && scope.brandId) {
      const brand = await this.prisma.brand.findFirst({
        where: { id: scope.brandId, tenantId },
        select: { primaryLocationId: true },
      });
      locationId = brand?.primaryLocationId ?? null;
    }
    if (!locationId) return null;

    const loc = await this.prisma.location.findFirst({
      where: { id: locationId },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        postcode: true,
        addressLine1: true,
        city: true,
        country: true,
      },
    });
    if (!loc) return null;
    if (loc.latitude != null && loc.longitude != null) {
      return { lat: loc.latitude, lng: loc.longitude };
    }

    // Outside the UK there is no postcode to geocode, so fall back to the
    // shop's street address. A Dubai shop whose origin can't be found puts
    // every one of its customers on the top band, which looks like a pricing
    // bug and is really a missing coordinate.
    const geo = await this.geocode(
      [loc.addressLine1, loc.city, loc.postcode].filter(Boolean).join(", "),
      loc.country,
    );
    if (!geo) return null;
    // Cache it — the shop doesn't move, and geocoding on every basket change
    // would be a paid call per keystroke.
    await this.prisma.location
      .update({
        where: { id: loc.id },
        data: { latitude: geo.lat, longitude: geo.lng },
      })
      .catch(() => undefined);
    return geo;
  }

  private async customerPoint(
    tenantId: string,
    scope: { locationId?: string; brandId?: string },
    customer: { lat?: number; lng?: number; postcode?: string; area?: string },
  ): Promise<{ lat: number; lng: number } | null> {
    if (customer.lat != null && customer.lng != null) {
      return { lat: customer.lat, lng: customer.lng };
    }
    const country = await this.countryFor(tenantId, scope);
    // Area then postcode — in the Gulf the community name is the only locatable
    // part of the address, and it geocodes perfectly well ("Dubai Marina, AE").
    const query = customer.postcode?.trim() || customer.area?.trim() || "";
    if (!query) return null;
    return this.geocode(query, country);
  }

  private async countryFor(
    tenantId: string,
    scope: { locationId?: string; brandId?: string },
  ): Promise<string> {
    if (scope.locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: scope.locationId },
        select: { country: true },
      });
      return loc?.country ?? "GB";
    }
    if (scope.brandId) {
      // Brand carries only the id — there is no relation field for it.
      const brand = await this.prisma.brand.findFirst({
        where: { id: scope.brandId, tenantId },
        select: { primaryLocationId: true },
      });
      if (brand?.primaryLocationId) {
        const loc = await this.prisma.location.findFirst({
          where: { id: brand.primaryLocationId },
          select: { country: true },
        });
        return loc?.country ?? "GB";
      }
    }
    return "GB";
  }

  /**
   * Geocode an address, biased to the shop's own country.
   *
   * postcodes.io is free and needs no key but is UK-ONLY — it was the sole
   * geocoder here, which is why radius bands silently mispriced every Gulf
   * order: both ends of the measurement resolved to null and the fail-safe
   * charged the top band. It stays as the free path for UK postcodes, with
   * Google (the key the dispatch map already uses) behind it for everywhere
   * else. Failure returns null and the caller charges the top band.
   */
  private async geocode(
    query: string,
    country: string | null | undefined,
  ): Promise<{ lat: number; lng: number } | null> {
    const cc = String(country ?? "GB").trim().toUpperCase() || "GB";
    const q = (query ?? "").trim();
    if (!q) return null;

    if (cc === "GB") {
      const viaPostcodesIo = await this.geocodePostcode(q);
      if (viaPostcodesIo) return viaPostcodesIo;
    }
    return this.geocodeViaGoogle(q, cc);
  }

  /** postcodes.io — free, no key, UK-only. */
  private async geocodePostcode(
    postcode: string,
  ): Promise<{ lat: number; lng: number } | null> {
    const pc = normalisePostcode(postcode);
    if (pc.length < 5) return null;
    try {
      const res = await fetch(
        `https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (!res.ok) return null;
      const body: any = await res.json();
      const lat = body?.result?.latitude;
      const lng = body?.result?.longitude;
      return typeof lat === "number" && typeof lng === "number"
        ? { lat, lng }
        : null;
    } catch {
      return null;
    }
  }

  /** Google Geocoding, restricted to the shop's country so "Marina" resolves
   *  to Dubai Marina and not to Marina del Rey. */
  private async geocodeViaGoogle(
    query: string,
    country: string,
  ): Promise<{ lat: number; lng: number } | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return null;
    try {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json` +
        `?address=${encodeURIComponent(query)}` +
        `&components=country:${encodeURIComponent(country)}` +
        `&key=${key}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const body: any = await res.json();
      if (body?.status !== "OK") return null;
      const loc = body?.results?.[0]?.geometry?.location;
      return typeof loc?.lat === "number" && typeof loc?.lng === "number"
        ? { lat: loc.lat, lng: loc.lng }
        : null;
    } catch {
      return null;
    }
  }
}

import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AM — DeliveryZone CRUD + postcode lookup.
//
// Lookup strategy: normalise the inbound postcode (uppercase, strip
// whitespace) then progressively shorten it from the right and search for
// the longest matching `postcodePrefix` on this location. This means a
// merchant can configure both broad areas ("SW1") and specific outcodes
// ("SW1A") and the more specific one always wins.

export interface CreateDeliveryZoneDto {
  locationId?: string;
  brandId?: string;
  /** Postcode mode. Exactly one of this or maxDistanceMiles. */
  postcodePrefix?: string;
  /** Radius mode — the outer edge of this band, in miles. */
  maxDistanceMiles?: number;
  fee: number;
  minOrderValue?: number;
  isActive?: boolean;
}

export interface UpdateDeliveryZoneDto {
  postcodePrefix?: string;
  maxDistanceMiles?: number | null;
  fee?: number;
  minOrderValue?: number | null;
  isActive?: boolean;
}

export interface LookupResult {
  matched: boolean;
  zoneId?: string;
  postcodePrefix?: string;
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

/**
 * Which band a distance falls in.
 *
 * Bands are outer edges: 3.0 then 4.0 means 0–3 miles and 3–4 miles. The
 * smallest band that still covers the distance wins.
 *
 * Past the furthest band we charge the TOP band rather than refusing. That
 * matches the rule already agreed for unrecognised postcodes — an order that
 * quotes nothing is an order that goes out with no delivery fee charged, which
 * is the failure that costs the shop money. `beyondLastBand` is set so the UI
 * can say so.
 */
export function resolveRadiusBand<T extends { maxDistanceMiles: unknown }>(
  bands: T[],
  distanceMiles: number,
): { band: T; beyondLastBand: boolean } | null {
  const sorted = [...bands]
    .filter((b) => b.maxDistanceMiles != null)
    .sort((x, y) => Number(x.maxDistanceMiles) - Number(y.maxDistanceMiles));
  if (!sorted.length) return null;
  const hit = sorted.find((b) => distanceMiles <= Number(b.maxDistanceMiles));
  return hit
    ? { band: hit, beyondLastBand: false }
    : { band: sorted[sorted.length - 1]!, beyondLastBand: true };
}

export function normalisePostcode(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/\s+/g, "");
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
      orderBy: [{ isActive: "desc" }, { postcodePrefix: "asc" }],
    });
  }

  async listForBrand(tenantId: string, brandId: string) {
    await this.assertBrand(tenantId, brandId);
    return this.prisma.deliveryZone.findMany({
      where: { brandId } as any,
      orderBy: [{ isActive: "desc" }, { postcodePrefix: "asc" }],
    });
  }

  async create(tenantId: string, dto: CreateDeliveryZoneDto) {
    const prefix = normalisePostcode(dto.postcodePrefix ?? "");
    const radius = dto.maxDistanceMiles;
    // One or the other. A row that is both would match twice and quote two
    // different fees depending on which resolver ran.
    if (prefix && radius != null) {
      throw new BadRequestException(
        "A zone is either a postcode prefix or a distance band, not both",
      );
    }
    if (!prefix && radius == null) {
      throw new BadRequestException(
        "postcodePrefix or maxDistanceMiles is required",
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

    return this.prisma.deliveryZone.create({
      data: {
        tenantId,
        locationId: dto.locationId ?? null,
        brandId: dto.brandId ?? null,
        postcodePrefix: prefix || null,
        maxDistanceMiles: radius ?? null,
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
   * Look up the delivery fee for a given postcode at this location. Returns
   * { matched: false, fee: 0 } when no zone matches — the POS UI can decide
   * whether to fail-closed (refuse delivery) or fall back to a global fee.
   */
  async lookup(
    tenantId: string,
    locationId: string,
    postcode: string,
  ): Promise<LookupResult> {
    await this.assertLocation(tenantId, locationId);
    const normalised = normalisePostcode(postcode);
    if (!normalised) return { matched: false, fee: 0 };

    const zones = await this.prisma.deliveryZone.findMany({
      where: { locationId, isActive: true },
    });

    // Radius mode: if this location has distance bands, they ARE the fee
    // model. Delegating here rather than at every call site means the
    // storefront, POS and cart panel all get radius support without knowing
    // it exists — and a shop can't end up quoting by postcode in one surface
    // and by distance in another.
    if (zones.some((z) => z.maxDistanceMiles != null)) {
      return this.lookupByDistance(tenantId, { locationId }, { postcode });
    }

    // Match the LONGEST prefix that the postcode starts with. Radius rows
    // carry no prefix, so they're skipped here.
    let best: (typeof zones)[number] | null = null;
    for (const z of zones) {
      if (!z.postcodePrefix) continue;
      const zp = normalisePostcode(z.postcodePrefix);
      if (normalised.startsWith(zp)) {
        if (
          !best ||
          zp.length > normalisePostcode(best.postcodePrefix ?? "").length
        ) {
          best = z;
        }
      }
    }

    if (!best) return { matched: false, fee: 0 };

    return {
      matched: true,
      zoneId: best.id,
      postcodePrefix: best.postcodePrefix ?? undefined,
      fee: Number(best.fee),
      minOrderValue: best.minOrderValue !== null ? Number(best.minOrderValue) : null,
    };
  }

  /**
   * Quote by distance rather than postcode.
   *
   * Takes the customer's coordinates where the caller has them (an address
   * picked from the lookup carries lat/lng) and otherwise geocodes their
   * postcode — a centroid is easily precise enough for a one-mile band, and
   * without the fallback every hand-typed address would quote nothing.
   */
  async lookupByDistance(
    tenantId: string,
    scope: { locationId?: string; brandId?: string },
    customer: { lat?: number; lng?: number; postcode?: string },
  ): Promise<LookupResult> {
    const zones = await this.prisma.deliveryZone.findMany({
      where: {
        isActive: true,
        ...(scope.brandId ? { brandId: scope.brandId } : {}),
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    });
    const bands = zones.filter((z) => z.maxDistanceMiles != null);
    if (!bands.length) return { matched: false, fee: 0 };

    const origin = await this.originFor(tenantId, scope);
    if (!origin) {
      // The shop has no coordinates, so nothing can be measured. Charge the
      // top band rather than nothing — same reasoning as beyondLastBand.
      const top = resolveRadiusBand(bands, Number.POSITIVE_INFINITY);
      if (!top) return { matched: false, fee: 0 };
      return {
        matched: true,
        zoneId: top.band.id,
        fee: Number(top.band.fee),
        minOrderValue:
          top.band.minOrderValue !== null ? Number(top.band.minOrderValue) : null,
        beyondLastBand: true,
      };
    }

    const point = await this.customerPoint(customer);
    if (!point) {
      const top = resolveRadiusBand(bands, Number.POSITIVE_INFINITY);
      if (!top) return { matched: false, fee: 0 };
      return {
        matched: true,
        zoneId: top.band.id,
        fee: Number(top.band.fee),
        minOrderValue:
          top.band.minOrderValue !== null ? Number(top.band.minOrderValue) : null,
        beyondLastBand: true,
      };
    }

    const distanceMiles = milesBetween(origin, point);
    const hit = resolveRadiusBand(bands, distanceMiles);
    if (!hit) return { matched: false, fee: 0 };
    return {
      matched: true,
      zoneId: hit.band.id,
      fee: Number(hit.band.fee),
      minOrderValue:
        hit.band.minOrderValue !== null ? Number(hit.band.minOrderValue) : null,
      distanceMiles: Math.round(distanceMiles * 100) / 100,
      beyondLastBand: hit.beyondLastBand,
    };
  }

  /** The shop's coordinates, geocoded from its postcode on first use. */
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
      select: { id: true, latitude: true, longitude: true, postcode: true },
    });
    if (!loc) return null;
    if (loc.latitude != null && loc.longitude != null) {
      return { lat: loc.latitude, lng: loc.longitude };
    }
    if (!loc.postcode) return null;

    const geo = await this.geocodePostcode(loc.postcode);
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

  private async customerPoint(customer: {
    lat?: number;
    lng?: number;
    postcode?: string;
  }): Promise<{ lat: number; lng: number } | null> {
    if (customer.lat != null && customer.lng != null) {
      return { lat: customer.lat, lng: customer.lng };
    }
    if (!customer.postcode) return null;
    return this.geocodePostcode(customer.postcode);
  }

  /**
   * postcodes.io — free, no key, UK-only, and already the fallback the address
   * lookup uses. Failure returns null and the caller charges the top band.
   */
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
}

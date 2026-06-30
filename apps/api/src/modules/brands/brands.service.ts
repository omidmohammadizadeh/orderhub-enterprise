import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { HubRiseLocationPauseService } from "../integrations/hubrise/hubrise-location-pause.service";
import { CloudflareService } from "./cloudflare.service";
import { RenderDomainsService } from "./render-domains.service";
import { hoursConfigured } from "../../common/opening-hours.util";

// Phase AN — Brand CRUD, extended with description/cuisine/logoUrl/
// isSuspended/primaryLocationId. A brand can be tenant-wide (the franchise
// case — Location.brandId points back) or scoped to a single location
// (the "virtual brand" / ghost-kitchen case — primaryLocationId is set).

export interface CreateBrandDto {
  name: string;
  slug?: string;
  description?: string;
  cuisine?: string;
  logoUrl?: string;
  primaryLocationId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateBrandDto {
  name?: string;
  description?: string | null;
  cuisine?: string | null;
  logoUrl?: string | null;
  isSuspended?: boolean;
  isActive?: boolean;
  primaryLocationId?: string | null;
  metadata?: Record<string, unknown>;
  // Phase AS-6 — brand-level storefront
  onlineOrderingSlug?: string | null;
  directOrderingEnabled?: boolean;
  about?: string | null;
  // Phase AW — customer-facing storefront identity on the brand. Each
  // virtual brand running out of a kitchen carries its own address /
  // phone / custom domain / Stripe payout account so receipts, the
  // storefront header, and platform payouts all reflect the brand
  // the customer ordered from — not the kitchen.
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postcode?: string | null;
  country?: string;
  customDomain?: string | null;
  customDomainStatus?: string;
  stripeConnectedAccountId?: string | null;
  applicationFeeFixedAmount?: number | null;
  applicationFeePercentage?: number | null;
  applicationFeeMode?: string;
  // Phase AW-16 — brand-level opening hours + prep time. Published
  // through to HubRise (+ future channels) via /v1/brands/:id/publish-hours.
  openingHours?: any;
  prepTime?: number | null;
  busyExtraPrepTime?: number | null;
}

function slugify(name: string): string {
  return (
    (name ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "brand"
  );
}

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    // Phase AW-16 — HubRise location PATCH for the Publish Hours flow.
    // forwardRef in case the integration module ever imports brands.
    @Inject(forwardRef(() => HubRiseLocationPauseService))
    private readonly hubrise: HubRiseLocationPauseService,
    private readonly cloudflare: CloudflareService,
    private readonly render: RenderDomainsService,
  ) {}

  /** List brands for a tenant. When locationId is given, returns brands
   *  whose primaryLocationId === locationId (virtual brands at that
   *  location) PLUS the franchise brand the location belongs to.
   *
   *  Phase AR — when userId is passed, also restrict to brands the
   *  user has either an explicit UserBrand row for, OR brands whose
   *  primaryLocationId is in their UserLocation set (so an Owner
   *  scoped to "pizza uno pelton" sees the brands at that location
   *  but not brands at a sibling location). Empty scope falls back
   *  to tenant-wide so a freshly-created operator isn't locked out. */
  async findAll(tenantId: string, locationId?: string, userId?: string) {
    let allowedBrandIds: string[] | null = null;
    if (userId) {
      const [explicit, scopedLocations] = await Promise.all([
        (this.prisma as any).userBrand.findMany({
          where: { userId },
          select: { brandId: true },
        }),
        (this.prisma as any).userLocation.findMany({
          where: { userId },
          select: { locationId: true },
        }),
      ]);
      const explicitIds = explicit.map((r: any) => r.brandId);
      const locationIds = scopedLocations.map((r: any) => r.locationId);
      const viaLocations = locationIds.length
        ? await this.prisma.brand.findMany({
            where: {
              tenantId,
              deletedAt: null,
              OR: [
                { primaryLocationId: { in: locationIds } },
                { locations: { some: { id: { in: locationIds } } } },
              ],
            },
            select: { id: true },
          })
        : [];
      allowedBrandIds = Array.from(
        new Set([...explicitIds, ...viaLocations.map((b) => b.id)]),
      );
      // No fallback. If the user has no scope, they see no brands —
      // matches the LocationsService behaviour and lets the
      // no-access screen catch them upstream.
      if (allowedBrandIds.length === 0) return [];
    }

    if (!locationId) {
      return this.prisma.brand.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowedBrandIds && { id: { in: allowedBrandIds } }),
        },
        include: { _count: { select: { locations: true, platformConnections: true } } },
        orderBy: { createdAt: "asc" },
      });
    }

    // Phase AN follow-up: brands listed at a location are STRICTLY scoped
    // to that location via primaryLocationId. We no longer leak the
    // tenant's default "Main" / franchise parent brand here — the
    // operator wants this list to be "brands that operate FROM this
    // physical kitchen" only.
    return this.prisma.brand.findMany({
      where: {
        tenantId,
        deletedAt: null,
        primaryLocationId: locationId,
        ...(allowedBrandIds && { id: { in: allowedBrandIds } }),
      },
      include: { _count: { select: { platformConnections: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  async findOne(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      include: {
        locations: { where: { deletedAt: null } },
        platformConnections: true,
      },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }

  async create(tenantId: string, dto: CreateBrandDto) {
    const slug = dto.slug ?? slugify(dto.name);
    const existing = await this.prisma.brand.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException("Brand slug already in use");
    }

    return this.prisma.brand.create({
      data: {
        tenantId,
        name: dto.name,
        slug,
        description: dto.description ?? null,
        cuisine: dto.cuisine ?? null,
        logoUrl: dto.logoUrl ?? null,
        primaryLocationId: dto.primaryLocationId ?? null,
        metadata: (dto.metadata ?? {}) as any,
      },
    });
  }

  async update(brandId: string, tenantId: string, dto: UpdateBrandDto) {
    await this.assertAccess(brandId, tenantId);
    return this.prisma.brand.update({
      where: { id: brandId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.cuisine !== undefined && { cuisine: dto.cuisine }),
        ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
        ...(dto.isSuspended !== undefined && { isSuspended: dto.isSuspended }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.primaryLocationId !== undefined && {
          primaryLocationId: dto.primaryLocationId,
        }),
        ...(dto.metadata && { metadata: dto.metadata as any }),
        // Phase AS-6 — brand-level storefront fields. Stored on the
        // Brand row so the public /brand/<slug> route can resolve the
        // brand without joining DirectOrderingConfig (that table is
        // scoped per-location and would force a redundant row per
        // brand). `onlineOrderingSlug` is unique across all brands.
        ...(dto.onlineOrderingSlug !== undefined && {
          onlineOrderingSlug: dto.onlineOrderingSlug,
        }),
        ...(dto.directOrderingEnabled !== undefined && {
          directOrderingEnabled: dto.directOrderingEnabled,
        }),
        ...(dto.about !== undefined && { about: dto.about }),
        // Phase AW — brand-level storefront identity. Every field is
        // optional so partial PATCHes from the settings drawer don't
        // wipe out unrelated columns; explicit nulls clear a value.
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.addressLine1 !== undefined && { addressLine1: dto.addressLine1 }),
        ...(dto.addressLine2 !== undefined && { addressLine2: dto.addressLine2 }),
        ...(dto.city !== undefined && { city: dto.city }),
        ...(dto.postcode !== undefined && { postcode: dto.postcode }),
        ...(dto.country !== undefined && { country: dto.country }),
        ...(dto.customDomain !== undefined && { customDomain: dto.customDomain }),
        ...(dto.customDomainStatus !== undefined && {
          customDomainStatus: dto.customDomainStatus,
        }),
        ...(dto.stripeConnectedAccountId !== undefined && {
          stripeConnectedAccountId: dto.stripeConnectedAccountId,
        }),
        ...(dto.applicationFeeFixedAmount !== undefined && {
          applicationFeeFixedAmount: dto.applicationFeeFixedAmount as any,
        }),
        ...(dto.applicationFeePercentage !== undefined && {
          applicationFeePercentage: dto.applicationFeePercentage as any,
        }),
        ...(dto.applicationFeeMode !== undefined && {
          applicationFeeMode: dto.applicationFeeMode,
        }),
        ...(dto.openingHours !== undefined && {
          openingHours: dto.openingHours,
        }),
        ...(dto.prepTime !== undefined && { prepTime: dto.prepTime } as any),
        ...(dto.busyExtraPrepTime !== undefined && {
          busyExtraPrepTime: dto.busyExtraPrepTime,
        } as any),
      },
    });
  }

  // Phase AW — unique slug generator for the brand storefront URL.
  // Same shape as locations.generateUniqueSlug: derive a base from the
  // name, suffix -2/-3 until a free one exists. Scoped per-tenant
  // because onlineOrderingSlug is globally unique.
  async generateUniqueSlug(
    name: string,
    ignoreBrandId?: string,
  ): Promise<string> {
    const base = slugify(name);
    let candidate = base;
    let counter = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const clash = await this.prisma.brand.findFirst({
        where: {
          onlineOrderingSlug: candidate,
          deletedAt: null,
          ...(ignoreBrandId && { NOT: { id: ignoreBrandId } }),
        },
        select: { id: true },
      });
      if (!clash) return candidate;
      counter += 1;
      candidate = `${base}-${counter}`;
    }
  }

  /** Set or auto-generate the brand's online-ordering slug. Returns the
   *  resolved slug — the controller decorates it with the public URL. */
  async setSlug(brandId: string, tenantId: string, requestedSlug?: string | null) {
    const brand = await this.assertAccess(brandId, tenantId);
    const slug = requestedSlug
      ? slugify(requestedSlug)
      : await this.generateUniqueSlug(brand.name, brandId);
    if (requestedSlug) {
      const clash = await this.prisma.brand.findFirst({
        where: {
          onlineOrderingSlug: slug,
          deletedAt: null,
          NOT: { id: brandId },
        },
        select: { id: true },
      });
      if (clash) throw new ConflictException("Slug already taken");
    }
    return this.prisma.brand.update({
      where: { id: brandId },
      data: { onlineOrderingSlug: slug, directOrderingEnabled: true },
    });
  }

  // Phase AS-6 — public storefront resolver. Returns the brand + its
  // primary location's address fields (the brand reuses them rather
  // than carrying duplicate copies). No tenant context is checked
  // because this endpoint is intentionally public; the route is
  // mounted on /v1/public/brands/:slug and the slug itself is the
  // bearer of authorization — knowing it is enough to view the
  // storefront, just like /order/<location-slug>.
  async findBySlug(slug: string) {
    // Phase AW — prefer brand-level address/phone (the customer-facing
    // identity). Fall back to the brand's primary location for any
    // brand that hasn't filled the new fields yet, so existing
    // single-brand-per-location setups keep rendering. The storefront
    // never sees the location id directly; everything customer-facing
    // is keyed off the brand from here on.
    const brand = await this.prisma.brand.findUnique({
      where: { onlineOrderingSlug: slug },
      select: {
        id: true,
        name: true,
        slug: true,
        about: true,
        logoUrl: true,
        cuisine: true,
        directOrderingEnabled: true,
        primaryLocationId: true,
        phone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postcode: true,
        country: true,
        customDomain: true,
      },
    });
    if (!brand || !brand.directOrderingEnabled) return null;

    const fallbackLocation = brand.primaryLocationId
      ? await this.prisma.location.findUnique({
          where: { id: brand.primaryLocationId },
          select: {
            id: true,
            name: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            postcode: true,
            country: true,
            phone: true,
            // Phase AW-30 — operator-side change: the dedicated
            // location-level URL was retired, so onlineOrderingSlug
            // is null on most rows now. The legacy `slug` column
            // still carries the original location handle and is
            // accepted by the ordering API's storefront lookup
            // (slug OR onlineOrderingSlug), so we fall through to
            // it before giving up. id is the last-resort target
            // since the storefront route also accepts a raw id.
            slug: true,
            onlineOrderingSlug: true,
            timezone: true,
            openingHours: true,
            isOpen: true,
            busyMode: true,
            currentPrepTime: true,
            googleReviewUrl: true,
            status: true,
          },
        })
      : null;
    if (!fallbackLocation) return null;

    // Single storefront slug the brand page can redirect to without
    // re-implementing the fallback chain on the client. Whatever this
    // resolves to is guaranteed to work against /v1/ordering/store/
    // (the ordering API accepts onlineOrderingSlug, legacy slug, or
    // id via its OR-where).
    const storefrontSlug =
      fallbackLocation.onlineOrderingSlug ??
      fallbackLocation.slug ??
      fallbackLocation.id;

    return {
      brand,
      // Public storefront read shape: brand fields win when set,
      // otherwise the location backstops them.
      location: {
        ...fallbackLocation,
        storefrontSlug,
        addressLine1: brand.addressLine1 ?? fallbackLocation.addressLine1,
        addressLine2: brand.addressLine2 ?? fallbackLocation.addressLine2,
        city: brand.city ?? fallbackLocation.city,
        postcode: brand.postcode ?? fallbackLocation.postcode,
        country: brand.country ?? fallbackLocation.country,
        phone: brand.phone ?? fallbackLocation.phone,
      },
    };
  }

  // ── Custom domains (Render native custom domains) ────────────────────────

  private normaliseDomain(raw?: string | null): string {
    return (raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.$/, "");
  }

  private domainPayload(domain: string, status: string) {
    return {
      configured: !!domain,
      domain,
      status, // not_configured | pending | verified
      // Kept for the existing panel shape; unused with Render.
      fallbackOrigin: "",
      dnsRecords: domain ? this.render.dnsRecordsFor(domain) : [],
    };
  }

  /** Register a brand's domain on the Render web service (auto-SSL). */
  async connectDomain(brandId: string, tenantId: string, rawDomain: string) {
    await this.assertAccess(brandId, tenantId);
    if (!this.render.configured) {
      throw new BadRequestException(
        "Custom domains aren't configured on the server yet (missing Render API settings).",
      );
    }
    const domain = this.normaliseDomain(rawDomain);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      throw new BadRequestException("Enter a valid domain, e.g. order.yourshop.com");
    }
    const clash = await this.prisma.brand.findFirst({
      where: { customDomain: domain, id: { not: brandId }, deletedAt: null },
      select: { id: true },
    });
    if (clash) throw new BadRequestException("That domain is already connected to another brand.");

    const rd = await this.render.create(domain);
    const status = rd.verified ? "verified" : "pending";
    await this.prisma.brand.update({
      where: { id: brandId },
      data: { customDomain: domain, customDomainStatus: status },
    });
    return this.domainPayload(domain, status);
  }

  /** Re-check the domain's verification status on Render. */
  async domainStatus(brandId: string, tenantId: string) {
    await this.assertAccess(brandId, tenantId);
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { customDomain: true, customDomainStatus: true },
    });
    if (!brand?.customDomain) return this.domainPayload("", "not_configured");

    let status = brand.customDomainStatus;
    if (this.render.configured) {
      await this.render.triggerVerify(brand.customDomain);
      const rd = await this.render.findByName(brand.customDomain).catch(() => null);
      if (rd) {
        status = rd.verified ? "verified" : "pending";
        if (status !== brand.customDomainStatus) {
          await this.prisma.brand.update({
            where: { id: brandId },
            data: { customDomainStatus: status },
          });
        }
      }
    }
    return this.domainPayload(brand.customDomain, status);
  }

  async disconnectDomain(brandId: string, tenantId: string) {
    await this.assertAccess(brandId, tenantId);
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { customDomain: true },
    });
    if (brand?.customDomain && this.render.configured) {
      await this.render.remove(brand.customDomain).catch(() => undefined);
    }
    await this.prisma.brand.update({
      where: { id: brandId },
      data: { customDomain: null, customDomainStatus: "not_configured" },
    });
    return this.domainPayload("", "not_configured");
  }

  /** Public: map an inbound Host → the brand's storefront (slug + brandId).
   *  Used by the web middleware to render a custom domain as the storefront. */
  async resolveCustomDomain(host: string): Promise<{ slug: string; brandId: string } | null> {
    const domain = this.normaliseDomain(host);
    if (!domain) return null;
    // Resolve on customDomain match + ordering enabled. We deliberately do NOT
    // gate on customDomainStatus: the request only reaches us if the domain's
    // DNS already points at our origin, and status tracking varies by provider
    // (Render-native vs the older Cloudflare flow).
    const brand = await this.prisma.brand.findFirst({
      where: {
        customDomain: domain,
        directOrderingEnabled: true,
        deletedAt: null,
      },
      select: { id: true, primaryLocationId: true },
    });
    if (!brand?.primaryLocationId) return null;
    const loc = await this.prisma.location.findUnique({
      where: { id: brand.primaryLocationId },
      select: { id: true, slug: true, onlineOrderingSlug: true },
    });
    if (!loc) return null;
    const slug = loc.onlineOrderingSlug ?? loc.slug ?? loc.id;
    return { slug, brandId: brand.id };
  }

  async remove(brandId: string, tenantId: string) {
    await this.assertAccess(brandId, tenantId);
    await this.prisma.brand.update({
      where: { id: brandId },
      data: { deletedAt: new Date() },
    });
  }

  // Phase AW-16 — publish the brand's openingHours + prepTime out
  // through one channel. For HUBRISE we PATCH /v1/locations/:id.
  // POS / ONLINE are no-ops here — the storefront + POS read brand
  // overlay at request time, so nothing extra to push. Marketplace
  // channels (Just Eat / Uber Eats / Deliveroo / WhatsApp) return a
  // soft success today so the UI can record the operator's intent;
  // each direct push gets wired in its own follow-up phase.
  async publishHours(brandId: string, tenantId: string, channel: string) {
    const brand = (await this.assertAccess(brandId, tenantId)) as any;
    if (!channel) throw new BadRequestException("channel required");

    switch (channel) {
      case "ONLINE":
      case "POS":
        // Local channels — storefront + POS overlay brand-first when
        // a brand is pinned (see AW-2 ordering.service overlay), so
        // updating the brand row IS the publish. No-op here.
        return { channel, status: "ok", pushed: false };

      case "HUBRISE": {
        // Find any HubRise-connected location this brand operates at.
        // primary-location virtual brands use their primaryLocationId;
        // a kitchen-default brand picks its first attached location.
        const location = await this.prisma.location.findFirst({
          where: {
            OR: [
              { id: brand.primaryLocationId ?? "" },
              { brandId, hubriseLocationId: { not: null } },
            ],
            hubriseLocationId: { not: null },
          },
          select: { id: true, openingHours: true, prepTime: true },
        });
        if (!location) {
          throw new BadRequestException(
            "No HubRise-connected location found for this brand. Connect HubRise on the location first.",
          );
        }
        // Location hours/prep are the source of truth for HubRise (the
        // HubRise location is the physical store). Fall back to the brand's
        // own schedule only when the location hasn't set one.
        const openingHours = hoursConfigured((location as any).openingHours)
          ? (location as any).openingHours
          : brand.openingHours;
        const prepTime = (location as any).prepTime ?? brand.prepTime ?? null;
        await this.hubrise.publishHours({
          locationId: location.id,
          openingHours,
          prepTime,
        });
        return { channel, status: "ok", pushed: true };
      }

      case "JUST_EAT":
      case "UBER_EATS":
      case "DELIVEROO":
      case "WHATSAPP":
        // Intent recorded; direct push lands in a future phase.
        return { channel, status: "pending_integration", pushed: false };

      default:
        throw new BadRequestException(`Unknown channel: ${channel}`);
    }
  }

  private async assertAccess(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }
}

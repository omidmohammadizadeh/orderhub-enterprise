import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../integrations/credential-encryption.service";

// Phase AN — Locations service: full general-tab CRUD + opening-hours +
// busy-mode + Stripe-fee setters + slug generator. Brand and platform-
// connection CRUD lives in their own modules; they call into here only
// for tenant-access checks.

// Phase AN follow-up: everything except `name` is optional on create so
// an operator can stand up a placeholder location and fill the rest in
// later. brandId is also optional — when omitted we find-or-create a
// default tenant brand so the FK is satisfied without forcing the
// operator through a brand picker first.
export interface AddressInput {
  line1?: string;
  line2?: string;
  city?: string;
  postcode?: string;
  country?: string;
}

export interface CreateLocationDto {
  brandId?: string;
  name: string;
  address?: AddressInput;
  phone?: string;
  timezone?: string;
}

export interface UpdateLocationDto {
  name?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  postcode?: string;
  country?: string;
  phone?: string | null;
  about?: string | null;
  logoUrl?: string | null;
  googleReviewUrl?: string | null;
  customDomain?: string | null;
  customDomainStatus?: "not_configured" | "pending" | "verified" | "failed";
  onlineOrderingSlug?: string | null;
  // Phase AU — HubRise. Operator pastes the access token they
  // generated against this HubRise location; we encrypt it via
  // CredentialEncryptionService and store the envelope in
  // Location.hubriseCredentials. Passing `""` (empty string)
  // explicitly clears the stored credentials so an operator can
  // disconnect without going through a separate endpoint. Passing
  // `undefined` leaves the existing credentials untouched (the
  // normal "I only want to change other fields" path).
  hubriseAccessToken?: string | null;
  hubriseCatalogId?: string | null;
  // HubRise's own location id — needed for menu publish, order status
  // PATCH, inventory 86, and pause/resume. Distinct from our internal
  // `locationId`. Manual paste users get a field; OAuth populates it
  // automatically.
  hubriseLocationId?: string | null;
  stripeConnectedAccountId?: string | null;
  applicationFeeFixedAmount?: number | null;
  applicationFeePercentage?: number | null;
  applicationFeeMode?: "none" | "fixed_only" | "percentage_only" | "fixed_and_percentage";
  status?: "active" | "suspended" | "closed";
  timezone?: string;
  isActive?: boolean;
  // Phase AZ — location-level prep time (minutes). HubRise + WhatsApp fall
  // back to these when the brand hasn't set its own.
  prepTime?: number | null;
  busyExtraPrepTime?: number | null;
  // Free-form Json blob persisted on Location.settings. Merged shallow
  // into whatever is already stored so unrelated keys (set by other
  // tabs) aren't clobbered. Currently used for:
  //   - autoAcceptOrders: Boolean — when true, incoming orders skip
  //     PENDING and go straight to ACCEPTED via OrdersService.
  settings?: Record<string, unknown>;
}

export interface OpeningSlot {
  from: string; // "HH:MM"
  to: string;
}
export interface DaySchedule {
  enabled: boolean;
  slots: OpeningSlot[];
}
export type OpeningHours = Record<
  "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday",
  DaySchedule
>;


const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Turn an arbitrary location name into a URL-safe slug.
 *  "KLO – Consett (#1)" → "klo-consett-1". */
export function slugifyName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "location";
}

/** Customer-facing online-ordering URL — composed from env, no DB hit. */
export function buildOnlineOrderingUrl(slug: string): string {
  const base =
    process.env.APP_URL ??
    process.env.WEB_URL ??
    "https://orderhub-web.onrender.com";
  return `${base.replace(/\/+$/, "")}/order/${slug}`;
}

// ── Stripe application-fee helpers ──────────────────────────────────────────
//
// Two distinct cost models, both honoured per Phase AN spec:
//
//   * Fixed app fee  → added to the customer bill.
//   * Percent app fee → deducted from the merchant's Stripe payout.
//
// When both are set, fixed adds to the customer total AND percent is
// deducted from the payout. These helpers produce the canonical numbers
// the Stripe PaymentIntent / application_fee_amount logic will use later.

export interface FeeConfig {
  mode: "none" | "fixed_only" | "percentage_only" | "fixed_and_percentage";
  fixed?: number | null;
  percentage?: number | null;
}

export function customerTotalWithFee(basket: number, cfg: FeeConfig): number {
  const fixed = cfg.fixed ?? 0;
  const addsFixed = cfg.mode === "fixed_only" || cfg.mode === "fixed_and_percentage";
  const total = basket + (addsFixed ? fixed : 0);
  return Math.round(total * 100) / 100;
}

export function applicationFeeAmount(basket: number, cfg: FeeConfig): number {
  // The Stripe PaymentIntent.application_fee_amount field collects the
  // fixed portion + the percent portion. Both are taken out of the
  // payout; the fixed portion was added to the customer total upstream,
  // so the net effect for the merchant is "percent only".
  const fixed = cfg.fixed ?? 0;
  const pct = cfg.percentage ?? 0;
  const usesFixed = cfg.mode === "fixed_only" || cfg.mode === "fixed_and_percentage";
  const usesPct = cfg.mode === "percentage_only" || cfg.mode === "fixed_and_percentage";
  const fixedPart = usesFixed ? fixed : 0;
  const pctPart = usesPct ? basket * (pct / 100) : 0;
  return Math.round((fixedPart + pctPart) * 100) / 100;
}

export function merchantPayout(basket: number, cfg: FeeConfig): number {
  // basket - percentage portion (fixed was added to customer total and
  // is forwarded to OrderHub, so it doesn't affect the merchant payout
  // beyond the application_fee_amount split).
  const pct = cfg.percentage ?? 0;
  const usesPct = cfg.mode === "percentage_only" || cfg.mode === "fixed_and_percentage";
  const payout = basket - (usesPct ? basket * (pct / 100) : 0);
  return Math.round(payout * 100) / 100;
}

// ── Opening-hours helpers ───────────────────────────────────────────────────

export function emptyOpeningHours(): OpeningHours {
  const out = {} as OpeningHours;
  for (const d of WEEKDAYS) {
    out[d] = { enabled: false, slots: [] };
  }
  return out;
}

/** Copy one day's schedule onto every other listed day. */
export function copyDayToDays(
  hours: OpeningHours,
  sourceDay: keyof OpeningHours,
  targetDays: Array<keyof OpeningHours>,
): OpeningHours {
  const src = hours[sourceDay];
  const out = { ...hours };
  for (const day of targetDays) {
    if (day === sourceDay) continue;
    out[day] = {
      enabled: src.enabled,
      slots: src.slots.map((s) => ({ ...s })),
    };
  }
  return out;
}

/** Is the location open at the given moment, given its opening hours?
 *  Returns false when hours is empty/malformed (treated as 24/7 OFF). */
export function isOpenAt(hours: OpeningHours | null | undefined, at: Date): boolean {
  if (!hours) return false;
  const dayKey = WEEKDAYS[at.getDay()];
  if (!dayKey) return false;
  const day = hours[dayKey];
  if (!day || !day.enabled) return false;
  const minutes = at.getHours() * 60 + at.getMinutes();
  return day.slots.some((s: OpeningSlot) => {
    const [fh = 0, fm = 0] = s.from.split(":").map(Number);
    const [th = 0, tm = 0] = s.to.split(":").map(Number);
    const from = fh * 60 + fm;
    let to = th * 60 + tm;
    if (to <= from) to += 24 * 60; // wraps past midnight
    const m = minutes < from ? minutes + 24 * 60 : minutes;
    return m >= from && m <= to;
  });
}

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentialEncryption: CredentialEncryptionService,
  ) {}

  async findAll(
    tenantId: string,
    brandId?: string,
    // Phase AR — when userId is passed, restrict to the locations
    // that user has been explicitly assigned to via UserLocation.
    // Tenant-wide roles (PLATFORM_ADMIN / TENANT_OWNER) skip this
    // check by not passing userId from the controller.
    //
    // No safety fallback. If a scoped user has zero rows, return
    // zero locations — that's the signal AccessGate uses to show
    // the no-access screen. Granting tenant-wide access on empty
    // scope (which earlier versions did) silently leaked every
    // location to brand-new accounts.
    userId?: string,
  ) {
    let allowedLocationIds: string[] | null = null;
    if (userId) {
      allowedLocationIds = await this.accessibleLocationIds(tenantId, userId);
      // No tenant-wide fallback — a scoped user with zero assignments sees
      // zero locations (AccessGate shows the no-access screen), never the
      // whole tenant.
      if (allowedLocationIds.length === 0) return [];
    }

    const rows = await this.prisma.location.findMany({
      where: {
        deletedAt: null,
        brand: { tenantId, ...(brandId && { id: brandId }) },
        ...(allowedLocationIds && { id: { in: allowedLocationIds } }),
      },
      include: {
        brand: { select: { id: true, name: true } },
        _count: { select: { platformConnections: true } },
      },
      orderBy: { name: "asc" },
    });
    // Same safety net as findOne — drop the encrypted HubRise blob,
    // surface a boolean instead.
    return rows.map(({ hubriseCredentials, ...rest }: any) => ({
      ...rest,
      hubriseConnected: !!hubriseCredentials,
    }));
  }

  /**
   * Phase AR — the locations a user may see: explicit UserLocation rows ∪
   * the locations their assigned brands (UserBrand) operate at. Mirrors
   * OrdersService.resolveOrderScope so the switcher, orders board, and
   * location settings all agree on the user's accessible set. Tenant-wide
   * roles never call this (the controller passes no userId for them).
   */
  private async accessibleLocationIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    const [locRows, brandRows] = await Promise.all([
      (this.prisma as any).userLocation.findMany({
        where: { userId },
        select: { locationId: true },
      }),
      (this.prisma as any).userBrand.findMany({
        where: { userId },
        select: { brandId: true },
      }),
    ]);
    const ids = new Set<string>(locRows.map((r: any) => r.locationId));
    const brandIds: string[] = brandRows.map((r: any) => r.brandId);
    if (brandIds.length) {
      const brands = await this.prisma.brand.findMany({
        where: { id: { in: brandIds }, tenantId },
        select: {
          primaryLocationId: true,
          locations: { select: { id: true } },
        },
      });
      for (const b of brands) {
        if (b.primaryLocationId) ids.add(b.primaryLocationId);
        for (const l of b.locations) ids.add(l.id);
      }
    }
    return Array.from(ids);
  }

  async findOne(locationId: string, tenantId: string, userId?: string) {
    // Phase AR — scope settings the same way as the switcher: a non-
    // tenant-wide user can only open the settings of a location they're
    // assigned to (UserLocation, or a location one of their brands runs
    // at). Controllers pass userId only for scoped roles.
    if (userId) {
      const allowed = await this.accessibleLocationIds(tenantId, userId);
      if (!allowed.includes(locationId)) {
        throw new NotFoundException("Location not found");
      }
    }
    // Phase AN follow-up: keep this lean. The edit modal only needs the
    // location's own columns + brand summary; platform connections,
    // printers, KDS, integrations are loaded by their own panels when
    // their tab opens, and including them here was both wasteful and a
    // failure surface (a single relation rename anywhere blew up the
    // whole modal with a 500 → endless "Loading…").
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      include: {
        brand: { select: { id: true, name: true } },
      },
    });
    if (!location) throw new NotFoundException("Location not found");
    // Phase AU — never return the encrypted HubRise credentials blob
    // to the dashboard. The form only needs to know whether one is
    // configured + when, plus the catalog id (which isn't sensitive).
    const { hubriseCredentials, ...safe } = location as any;
    return {
      ...safe,
      hubriseConnected: !!hubriseCredentials,
    };
  }

  async create(tenantId: string, dto: CreateLocationDto) {
    // Resolve the brand. Explicit brandId wins; otherwise reuse the first
    // brand on this tenant, or seed a default "Main" brand when the
    // tenant has none. Operators add real brands later from the Brands
    // section so the create flow stays a single short form.
    const brandId = await this.resolveOrCreateDefaultBrand(tenantId, dto.brandId);

    const addr = dto.address ?? {};
    const openingHours = emptyOpeningHours();
    return this.prisma.location.create({
      data: {
        brandId,
        name: dto.name,
        // Keep the legacy address JSON in sync for any consumer that
        // still reads it (webhook adapters, older menu imports).
        address: {
          line1: addr.line1 ?? "",
          line2: addr.line2 ?? "",
          city: addr.city ?? "",
          postcode: addr.postcode ?? "",
          country: addr.country ?? "GB",
        } as any,
        addressLine1: addr.line1 ?? null,
        addressLine2: addr.line2 ?? null,
        city: addr.city ?? null,
        postcode: addr.postcode ?? null,
        country: addr.country ?? "GB",
        phone: dto.phone ?? null,
        timezone: dto.timezone ?? "Europe/London",
        openingHours: openingHours as any,
      },
    });
  }

  /**
   * Resolve a brand for the new location. Order:
   *   1. dto.brandId if it points to a live brand on this tenant
   *   2. The tenant's first non-deleted brand
   *   3. Create a default "Main" brand and use it
   */
  private async resolveOrCreateDefaultBrand(
    tenantId: string,
    explicitBrandId?: string,
  ): Promise<string> {
    if (explicitBrandId) {
      const brand = await this.prisma.brand.findFirst({
        where: { id: explicitBrandId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!brand) throw new NotFoundException("Brand not found");
      return brand.id;
    }

    const existing = await this.prisma.brand.findFirst({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing) return existing.id;

    // Tenant has no brands at all — seed one. Slug collision is unlikely
    // for a fresh tenant but we still pick a slug with a short suffix
    // so re-runs after a soft-delete don't collide.
    const created = await this.prisma.brand.create({
      data: { tenantId, name: "Main", slug: `main-${Date.now().toString(36)}` },
    });
    return created.id;
  }

  async update(locationId: string, tenantId: string, dto: UpdateLocationDto) {
    const current = await this.assertAccess(locationId, tenantId);

    // Phase AN follow-up: keep the legacy `address` JSON in sync with the
    // structured columns whenever any address field changes. Older
    // consumers (POS labels, webhook payloads) still read the JSON shape.
    const addressTouched =
      dto.addressLine1 !== undefined ||
      dto.addressLine2 !== undefined ||
      dto.city !== undefined ||
      dto.postcode !== undefined ||
      dto.country !== undefined;
    const mergedAddress = addressTouched
      ? {
          line1: dto.addressLine1 ?? current.addressLine1 ?? "",
          line2: dto.addressLine2 ?? current.addressLine2 ?? undefined,
          city: dto.city ?? current.city ?? "",
          postcode: dto.postcode ?? current.postcode ?? "",
          country: dto.country ?? current.country ?? "GB",
        }
      : null;

    // Phase AU — HubRise. If the operator supplied a non-empty token,
    // encrypt it now and emit a "configured today" timestamp. Empty
    // string clears the credentials (disconnect). `undefined` skips
    // the field entirely so other unrelated updates work.
    let hubriseCredentialsPatch:
      | { hubriseCredentials: any; hubriseConnectedAt: Date | null }
      | undefined;
    if (dto.hubriseAccessToken !== undefined) {
      if (dto.hubriseAccessToken && dto.hubriseAccessToken.trim().length > 0) {
        hubriseCredentialsPatch = {
          hubriseCredentials: this.credentialEncryption.encrypt({
            accessToken: dto.hubriseAccessToken.trim(),
          }) as any,
          hubriseConnectedAt: new Date(),
        };
      } else {
        hubriseCredentialsPatch = {
          hubriseCredentials: null,
          hubriseConnectedAt: null,
        };
      }
    }

    return this.prisma.location.update({
      where: { id: locationId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.addressLine1 !== undefined && { addressLine1: dto.addressLine1 }),
        ...(dto.addressLine2 !== undefined && { addressLine2: dto.addressLine2 }),
        ...(dto.city !== undefined && { city: dto.city }),
        ...(dto.postcode !== undefined && { postcode: dto.postcode }),
        ...(dto.country !== undefined && { country: dto.country }),
        ...(mergedAddress && { address: mergedAddress as any }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.about !== undefined && { about: dto.about }),
        ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
        ...(dto.googleReviewUrl !== undefined && { googleReviewUrl: dto.googleReviewUrl }),
        ...(dto.customDomain !== undefined && { customDomain: dto.customDomain }),
        ...(dto.customDomainStatus !== undefined && { customDomainStatus: dto.customDomainStatus }),
        ...(dto.onlineOrderingSlug !== undefined && { onlineOrderingSlug: dto.onlineOrderingSlug }),
        ...(dto.stripeConnectedAccountId !== undefined && {
          stripeConnectedAccountId: dto.stripeConnectedAccountId,
        }),
        ...(dto.applicationFeeFixedAmount !== undefined && {
          applicationFeeFixedAmount: dto.applicationFeeFixedAmount,
        }),
        ...(dto.applicationFeePercentage !== undefined && {
          applicationFeePercentage: dto.applicationFeePercentage,
        }),
        ...(dto.applicationFeeMode !== undefined && { applicationFeeMode: dto.applicationFeeMode }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.prepTime !== undefined && { prepTime: dto.prepTime }),
        ...(dto.busyExtraPrepTime !== undefined && {
          busyExtraPrepTime: dto.busyExtraPrepTime,
        }),
        // Phase AU — HubRise per-location credentials.
        ...(hubriseCredentialsPatch ?? {}),
        ...(dto.hubriseCatalogId !== undefined && {
          hubriseCatalogId: dto.hubriseCatalogId || null,
        }),
        ...(dto.hubriseLocationId !== undefined && {
          hubriseLocationId: dto.hubriseLocationId || null,
        }),
        ...(dto.settings !== undefined && {
          // Shallow merge — preserve unrelated keys other tabs persisted.
          settings: {
            ...((current.settings as Record<string, unknown>) ?? {}),
            ...dto.settings,
          } as any,
        }),
      },
    });
  }

  /**
   * Phase AN follow-up: try a HARD delete so the row genuinely leaves the
   * database. Most child rows that belong to the location cascade via
   * Prisma onDelete=Cascade (delivery zones, payment config, brand
   * platform connections, printers, integrations, KDS screens).
   *
   * Two exceptions need explicit handling:
   *   • Brand.primaryLocationId is a soft FK with no cascade. We null it
   *     out first so the brand row survives without dangling reference.
   *   • Order.locationId has onDelete=Restrict (financial history must
   *     never silently disappear). If any orders exist we fall back to
   *     a soft delete — the operator sees the row vanish from the UI
   *     while history is preserved for accounting / refunds.
   */
  async remove(locationId: string, tenantId: string) {
    await this.assertAccess(locationId, tenantId);

    const orderCount = await this.prisma.order.count({ where: { locationId } });
    if (orderCount > 0) {
      // Soft delete — preserve financial history.
      await this.prisma.location.update({
        where: { id: locationId },
        data: { deletedAt: new Date(), isActive: false, status: "closed" },
      });
      return { hardDeleted: false, orderCount };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.brand.updateMany({
        where: { primaryLocationId: locationId },
        data: { primaryLocationId: null },
      });
      await tx.location.delete({ where: { id: locationId } });
    });
    return { hardDeleted: true, orderCount: 0 };
  }

  // ── Slug ─────────────────────────────────────────────────────────────────

  /** Generate a unique online-ordering slug from the location name. Appends
   *  -2, -3, … until a free one is found. */
  async generateUniqueSlug(tenantId: string, name: string, ignoreId?: string): Promise<string> {
    const base = slugifyName(name);
    let candidate = base;
    let counter = 1;
    while (true) {
      const existing = await this.prisma.location.findFirst({
        where: {
          onlineOrderingSlug: candidate,
          deletedAt: null,
          brand: { tenantId },
          ...(ignoreId && { NOT: { id: ignoreId } }),
        },
        select: { id: true },
      });
      if (!existing) return candidate;
      counter += 1;
      candidate = `${base}-${counter}`;
    }
  }

  async setSlug(locationId: string, tenantId: string, slug: string) {
    await this.assertAccess(locationId, tenantId);
    const normalised = slugifyName(slug);
    // Uniqueness check ignoring self
    const clash = await this.prisma.location.findFirst({
      where: {
        onlineOrderingSlug: normalised,
        deletedAt: null,
        brand: { tenantId },
        NOT: { id: locationId },
      },
    });
    if (clash) throw new ConflictException("Slug already taken");
    return this.prisma.location.update({
      where: { id: locationId },
      data: { onlineOrderingSlug: normalised },
    });
  }

  // ── Opening hours ────────────────────────────────────────────────────────

  async getOpeningHours(locationId: string, tenantId: string): Promise<OpeningHours> {
    const loc = await this.assertAccess(locationId, tenantId);
    const hours = loc.openingHours as unknown as OpeningHours | null;
    return hours && typeof hours === "object" && !Array.isArray(hours)
      ? hours
      : emptyOpeningHours();
  }

  async setOpeningHours(
    locationId: string,
    tenantId: string,
    hours: OpeningHours,
  ) {
    await this.assertAccess(locationId, tenantId);
    return this.prisma.location.update({
      where: { id: locationId },
      data: { openingHours: hours as any },
    });
  }

  /** Apply one location's opening hours to a list of other locations
   *  belonging to the same tenant. */
  async copyHoursToLocations(
    sourceLocationId: string,
    tenantId: string,
    targetLocationIds: string[],
  ): Promise<number> {
    const source = await this.assertAccess(sourceLocationId, tenantId);
    const hours = source.openingHours;
    const targets = targetLocationIds.filter((id) => id !== sourceLocationId);
    if (targets.length === 0) return 0;
    const result = await this.prisma.location.updateMany({
      where: { id: { in: targets }, deletedAt: null, brand: { tenantId } },
      data: { openingHours: hours as any },
    });
    return result.count;
  }

  // ── Public storefront (unauthenticated) ─────────────────────────────────

  /**
   * Phase AN — Resolve a location by its public online-ordering slug.
   * Returns the safe-to-render presentation fields plus the active
   * menu's id, no tenant secrets. Used by the public `/order/:slug` page.
   */
  async findPublicBySlug(slug: string) {
    const location = await this.prisma.location.findFirst({
      where: {
        onlineOrderingSlug: slug,
        deletedAt: null,
        // Don't surface a closed shop from a stale link.
        status: { in: ["active", "suspended"] },
      },
      select: {
        id: true,
        name: true,
        about: true,
        logoUrl: true,
        googleReviewUrl: true,
        phone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postcode: true,
        country: true,
        timezone: true,
        status: true,
        isOpen: true,
        busyMode: true,
        currentPrepTime: true,
        openingHours: true,
        onlineOrderingSlug: true,
        brand: { select: { id: true, name: true, logoUrl: true } },
      },
    });
    if (!location) throw new NotFoundException("Storefront not found");

    // Resolve active menu id WITHOUT calling the menus service (avoid a
    // circular module dependency). Just need the id — the public menu
    // controller will fetch the published shape.
    //
    // Phase BA — assignment-first: same rule as the canonical resolver in
    // menus/menu-assignments.service.ts (inlined here to keep this module
    // dependency-free). The legacy OR cascade below is the fallback for
    // locations never re-published since the assignment migration.
    const assignments = await (this.prisma as any).menuChannelAssignment.findMany({
      where: {
        locationId: location.id,
        channel: "ONLINE",
        menu: { isActive: true, deletedAt: null },
      },
      orderBy: { publishedAt: "desc" },
      select: { menuId: true, brandId: true },
    });
    // Prefer the location's primary brand, then latest publish.
    const assignment =
      assignments.find((a: any) => a.brandId === location.brand.id) ??
      assignments[0] ??
      null;

    const menu = assignment
      ? { id: assignment.menuId as string }
      : await this.prisma.menu.findFirst({
          where: {
            OR: [
              { locationId: location.id, isActive: true, deletedAt: null },
              {
                brandId: location.brand.id,
                isActive: true,
                deletedAt: null,
                locationId: null,
              },
            ],
          },
          orderBy: { updatedAt: "desc" },
          select: { id: true, status: true },
        });

    return { location, menuId: menu?.id ?? null };
  }

  // ── Access guard ─────────────────────────────────────────────────────────

  private async assertAccess(locationId: string, tenantId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }
}

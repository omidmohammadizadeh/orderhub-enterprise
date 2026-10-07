import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// ── Website showcase (Admin Dashboard → Website showcase) ───────────────────
//
// The "Trusted by" wall on the marketing homepage. Cross-tenant on purpose:
// the wall is OUR marketing, so the platform team picks from every merchant's
// brands. Nothing is shown unless an admin switched it on — a brand never
// lands on orderhubsolutions.com just because it exists.
//
// "Live" = at least one real (non-sandbox) order in the last LIVE_WINDOW_DAYS.
// It is a hint on the admin screen and the filter for "Feature all live",
// never a reason to show a brand by itself.

const LIVE_WINDOW_DAYS = 30;

export interface ShowcaseAdminRow {
  brandId: string;
  brandName: string;
  tenantName: string;
  logoUrl: string | null;
  city: string | null;
  showcaseOnWebsite: boolean;
  showcaseOrder: number | null;
  ordersLast30d: number;
}

export interface ShowcasePublicBrand {
  name: string;
  logoUrl: string;
  city: string | null;
  cuisine: string | null;
  /** Relative storefront path when the brand takes direct orders. */
  orderUrl: string | null;
}

const BRAND_SELECT = {
  id: true,
  name: true,
  logoUrl: true,
  city: true,
  cuisine: true,
  onlineOrderingSlug: true,
  directOrderingEnabled: true,
  showcaseOnWebsite: true,
  showcaseOrder: true,
  tenant: { select: { name: true } },
  // Storefronts fall back to the location's logo when the brand has none; so
  // do we, or a brand that looks fine on its own shop would vanish here.
  locations: {
    where: { deletedAt: null },
    select: { logoUrl: true, address: true },
    take: 3,
  },
} as const;

type BrandRow = {
  id: string;
  name: string;
  logoUrl: string | null;
  city: string | null;
  cuisine: string | null;
  onlineOrderingSlug: string | null;
  directOrderingEnabled: boolean;
  showcaseOnWebsite: boolean;
  showcaseOrder: number | null;
  tenant: { name: string };
  locations: { logoUrl: string | null; address: unknown }[];
};

function logoOf(b: BrandRow): string | null {
  const own = b.logoUrl?.trim();
  if (own) return own;
  return b.locations.map((l) => l.logoUrl?.trim()).find((u) => !!u) ?? null;
}

function cityOf(b: BrandRow): string | null {
  if (b.city?.trim()) return b.city.trim();
  for (const l of b.locations) {
    const c = (l.address as { city?: unknown } | null)?.city;
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

@Injectable()
export class WebsiteShowcaseService {
  private readonly logger = new Logger(WebsiteShowcaseService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async liveCounts(): Promise<Map<string, number>> {
    const since = new Date(Date.now() - LIVE_WINDOW_DAYS * 86_400_000);
    const grouped = await this.prisma.order.groupBy({
      by: ["brandId"],
      where: { brandId: { not: null }, isSandbox: false, createdAt: { gte: since } },
      _count: { _all: true },
    });
    return new Map(
      grouped
        .filter((g) => g.brandId)
        .map((g) => [g.brandId as string, g._count._all]),
    );
  }

  private toAdminRow(b: BrandRow, counts: Map<string, number>): ShowcaseAdminRow {
    return {
      brandId: b.id,
      brandName: b.name,
      tenantName: b.tenant.name,
      logoUrl: logoOf(b),
      city: cityOf(b),
      showcaseOnWebsite: b.showcaseOnWebsite,
      showcaseOrder: b.showcaseOrder,
      ordersLast30d: counts.get(b.id) ?? 0,
    };
  }

  /** Every active brand on the platform: shown ones first, then busiest. */
  async list(): Promise<ShowcaseAdminRow[]> {
    const [brands, counts] = await Promise.all([
      this.prisma.brand.findMany({
        where: { deletedAt: null, isActive: true },
        select: BRAND_SELECT,
      }),
      this.liveCounts(),
    ]);
    return (brands as BrandRow[])
      .map((b) => this.toAdminRow(b, counts))
      .sort(
        (a, b) =>
          Number(b.showcaseOnWebsite) - Number(a.showcaseOnWebsite) ||
          (a.showcaseOrder ?? 1e9) - (b.showcaseOrder ?? 1e9) ||
          b.ordersLast30d - a.ordersLast30d ||
          a.brandName.localeCompare(b.brandName),
      );
  }

  async set(
    brandId: string,
    showcaseOnWebsite: boolean,
    showcaseOrder: number | null | undefined,
    actorId?: string,
  ): Promise<ShowcaseAdminRow> {
    const exists = await this.prisma.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException("Brand not found");
    const b = await this.prisma.brand.update({
      where: { id: brandId },
      data: {
        showcaseOnWebsite,
        ...(showcaseOrder !== undefined && { showcaseOrder }),
      },
      select: BRAND_SELECT,
    });
    this.logger.log(
      `Website showcase ${showcaseOnWebsite ? "ON" : "OFF"} for brand ${brandId} by ${actorId ?? "?"}`,
    );
    return this.toAdminRow(b as BrandRow, await this.liveCounts());
  }

  /** One click to seed the wall: every live brand that has a logo to show. */
  async featureAllLive(actorId?: string): Promise<{ featured: number }> {
    const rows = await this.list();
    const ids = rows
      .filter((r) => !r.showcaseOnWebsite && r.ordersLast30d > 0 && r.logoUrl)
      .map((r) => r.brandId);
    if (ids.length) {
      await this.prisma.brand.updateMany({
        where: { id: { in: ids } },
        data: { showcaseOnWebsite: true },
      });
    }
    this.logger.log(`Website showcase: featured ${ids.length} live brands by ${actorId ?? "?"}`);
    return { featured: ids.length };
  }

  /** What the homepage renders. A brand with no logo is skipped — a blank
   *  tile on the wall looks worse than one fewer name. */
  async publicList(): Promise<ShowcasePublicBrand[]> {
    const brands = (await this.prisma.brand.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        isSuspended: false,
        showcaseOnWebsite: true,
      },
      select: BRAND_SELECT,
    })) as BrandRow[];
    return brands
      .sort(
        (a, b) =>
          (a.showcaseOrder ?? 1e9) - (b.showcaseOrder ?? 1e9) ||
          a.name.localeCompare(b.name),
      )
      .flatMap((b) => {
        const logoUrl = logoOf(b);
        if (!logoUrl) return [];
        return [
          {
            name: b.name,
            logoUrl,
            city: cityOf(b),
            cuisine: b.cuisine?.trim() || null,
            orderUrl:
              b.directOrderingEnabled && b.onlineOrderingSlug
                ? `/brand/${b.onlineOrderingSlug}`
                : null,
          },
        ];
      });
  }
}

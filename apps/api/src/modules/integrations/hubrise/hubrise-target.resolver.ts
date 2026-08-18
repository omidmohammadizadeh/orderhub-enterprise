// Which HubRise location + catalog a menu publishes into.
//
// HubRise allows exactly ONE catalog per location (confirmed with HubRise,
// 2026-08-18). With the connection stored only on our Location, every virtual
// brand trading out of one kitchen had to share a single catalog — which is
// why operators were forced to merge everything into a master menu and use
// pricing variants to keep brands apart.
//
// The way out is one HubRise LOCATION per brand: HubRise locations are
// logical, not physical, so three brands in one kitchen can hold three
// HubRise locations and therefore three catalogs. That needs no schema
// change — BrandPlatformConnection already carries brandId + locationId +
// externalStoreId + metadata, and already lists HUBRISE among its platforms:
//
//   externalStoreId       → that brand's HubRise LOCATION id
//   metadata.catalogId    → that brand's HubRise CATALOG id
//   metadata.credentials  → encrypted token, same envelope as
//                           Location.hubriseCredentials
//
// STRICTLY ADDITIVE. A brand with no HubRise connection resolves exactly as
// it does today, through the Location columns — including the two hard rules
// the location path learned from a live bug (never a deleted location; prefer
// the menu's own location before any same-brand connected one). The working
// single-brand publish path is untouched; see
// [[feedback-dont-undo-working-code-on-advice]].

import type { PrismaService } from "../../../infrastructure/database/prisma.service";

export interface HubRiseTarget {
  /** Where the connection came from — logged so a wrong publish is traceable. */
  source: "brand" | "location";
  /** Our own Location id, for logs and downstream lookups. */
  locationId: string | null;
  hubriseLocationId: string;
  hubriseCatalogId: string | null;
  /** Encrypted envelope; the caller decrypts as it always has. */
  hubriseCredentials: unknown;
}

const LOCATION_SELECT = {
  id: true,
  hubriseCredentials: true,
  hubriseCatalogId: true,
  hubriseLocationId: true,
};

/**
 * Resolve the HubRise target for a menu.
 *
 * Order of preference:
 *   1. A connected HUBRISE BrandPlatformConnection for this brand — scoped to
 *      the menu's location when it has one, so a brand trading at two sites
 *      publishes each site's menu into that site's own HubRise location.
 *   2. The legacy Location columns, unchanged.
 *
 * Returns null when neither exists; the caller raises the operator-facing
 * error so the wording stays where it was.
 */
export async function resolveHubRiseTarget(
  prisma: PrismaService,
  args: { tenantId: string; brandId: string; locationId?: string | null },
): Promise<HubRiseTarget | null> {
  const conn = await (prisma as any).brandPlatformConnection.findFirst({
    where: {
      tenantId: args.tenantId,
      brandId: args.brandId,
      platform: "HUBRISE",
      status: "connected",
      // A brand at several sites has one connection per site. Prefer the
      // menu's own location; without one, any connected site for the brand.
      ...(args.locationId ? { locationId: args.locationId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    select: {
      locationId: true,
      externalStoreId: true,
      metadata: true,
    },
  });

  if (conn?.externalStoreId) {
    const meta = (conn.metadata ?? {}) as Record<string, any>;
    return {
      source: "brand",
      locationId: conn.locationId ?? null,
      hubriseLocationId: String(conn.externalStoreId),
      hubriseCatalogId: meta.catalogId ? String(meta.catalogId) : null,
      hubriseCredentials: meta.credentials ?? null,
    };
  }

  // ── Legacy location path, byte-for-byte the previous behaviour ──────────
  // 1. Never a deleted location. 2. Prefer the menu's OWN location, falling
  // back to a same-brand connected one only when it isn't itself connected.
  // Both rules come from a live bug where publishes 200'd against an orphaned
  // catalog on a deleted location while the order-receiving connection sat
  // elsewhere and never updated.
  let location = args.locationId
    ? await (prisma as any).location.findFirst({
        where: { id: args.locationId, deletedAt: null },
        select: LOCATION_SELECT,
      })
    : null;

  if (!location?.hubriseLocationId) {
    location = await (prisma as any).location.findFirst({
      where: {
        brandId: args.brandId,
        hubriseLocationId: { not: null },
        deletedAt: null,
      },
      orderBy: { updatedAt: "desc" },
      select: LOCATION_SELECT,
    });
  }

  if (!location?.hubriseLocationId) return null;

  return {
    source: "location",
    locationId: location.id,
    hubriseLocationId: String(location.hubriseLocationId),
    hubriseCatalogId: location.hubriseCatalogId ?? null,
    hubriseCredentials: location.hubriseCredentials ?? null,
  };
}

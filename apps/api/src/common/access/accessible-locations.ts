import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

/**
 * The locations a signed-in user may see.
 *
 * Explicit UserLocation rows, or — for a brand-only account with no location
 * assignments at all — the locations their brands operate at. Tenant-wide
 * roles get every location in the tenant.
 *
 * Explicit location assignments are AUTHORITATIVE: a user scoped to two shops
 * must not be widened to every shop their brand happens to run, so brands are
 * only expanded when there is no location scope to widen.
 *
 * This mirrors the copies inside DispatchService, LocationsService and
 * OrdersService. New callers should use this one; the older three are left
 * alone here rather than refactored inside a security fix.
 */
export async function accessibleLocationIds(
  prisma: any,
  user: Pick<AuthenticatedUser, "userId" | "tenantId" | "role">,
): Promise<string[]> {
  if (["PLATFORM_ADMIN", "TENANT_OWNER"].includes(String(user.role))) {
    // Location is tenant-scoped through its brand — there is no direct
    // tenantId column on Location.
    const locs = await prisma.location.findMany({
      where: { brand: { tenantId: user.tenantId } },
      select: { id: true },
    });
    return locs.map((l: any) => l.id);
  }

  // Fail closed. An unidentified caller gets nothing, never the tenant.
  if (!user.userId) return [];

  const [locRows, brandRows] = await Promise.all([
    prisma.userLocation.findMany({
      where: { userId: user.userId },
      select: { locationId: true },
    }),
    prisma.userBrand.findMany({
      where: { userId: user.userId },
      select: { brandId: true },
    }),
  ]);

  const ids = new Set<string>(locRows.map((r: any) => r.locationId));
  const brandIds: string[] = brandRows.map((r: any) => r.brandId);
  if (ids.size === 0 && brandIds.length) {
    const brands = await prisma.brand.findMany({
      where: { id: { in: brandIds }, tenantId: user.tenantId },
      select: { primaryLocationId: true, locations: { select: { id: true } } },
    });
    for (const b of brands) {
      if (b.primaryLocationId) ids.add(b.primaryLocationId);
      for (const l of b.locations) ids.add(l.id);
    }
  }
  return Array.from(ids);
}

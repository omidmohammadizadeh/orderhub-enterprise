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

/**
 * Which shops a DRIVER works at — answered from Team Roles, not from the
 * driver record.
 *
 * Driver.locationId used to be the answer, and it was a second place to say
 * the same thing: assigning somebody the DRIVER role and their locations on
 * Team Roles left them off their own shop's map until an operator went to
 * Fleet and picked the location again. Nothing on the Team Roles screen said
 * so, so a driver simply didn't appear and nobody knew why.
 *
 * Team Roles already records where a person works, for every other role, in
 * UserLocation. Drivers now read from the same place.
 *
 * Resolved as ids rather than through a relation because Driver has a bare
 * `userId` column and no `user` relation to traverse.
 */
export async function driverIdsForLocations(
  prisma: any,
  tenantId: string,
  locationIds: string[],
): Promise<string[]> {
  if (!locationIds.length) return [];
  const rows = await prisma.userLocation.findMany({
    where: { locationId: { in: locationIds } },
    select: { userId: true },
  });
  const userIds = Array.from(new Set<string>(rows.map((r: any) => r.userId)));
  if (!userIds.length) return [];
  const drivers = await prisma.driver.findMany({
    where: { tenantId, userId: { in: userIds } },
    select: { id: true },
  });
  return drivers.map((d: any) => d.id);
}

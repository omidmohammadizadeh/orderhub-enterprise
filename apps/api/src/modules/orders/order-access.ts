// Pure order-visibility logic, extracted out of OrdersService so it can be
// reused by the socket gateway (OrdersGateway) without creating a module
// dependency cycle — OrdersModule already imports SocketModule for
// SocketService, so SocketModule importing OrdersModule back for this would
// need forwardRef on both sides, and that cycle couldn't be verified against
// a real DI boot locally. A plain function taking PrismaService explicitly
// sidesteps the whole problem: no new module edge, single source of truth
// for "who can see which locations' orders" either way.

import type { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Admin roles that see every location/brand in their tenant (full access,
// no per-assignment scoping). "OWNER" is a SCOPED location-owner role (not
// an admin) — it's constrained to its assigned locations/brands like
// MANAGER / STAFF / DRIVER. Kept in sync with the TENANT_WIDE_ROLES set in
// the locations + brands controllers.
export const ORDER_ADMIN_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER"];

export interface OrderScope {
  admin: boolean;
  // Locations the user is DIRECTLY assigned to (owns the board here → sees
  // every brand's orders at these locations).
  directLocationIds: string[];
  // Brands the user is assigned to (sees these brands' orders wherever they
  // trade). null = no brand assignments.
  brandIds: string[] | null;
  // Every location the user may view at all (direct + brand-derived) — used
  // only to validate a requested-location filter, NOT to filter orders.
  allowedLocationIds: string[];
}

/**
 * Resolve the user's order visibility. Returns id allowlists where
 * `null` = unrestricted for that dimension. An empty `locationIds`
 * array means the (non-admin) user has no assignments → sees nothing.
 */
export async function resolveOrderScope(
  prisma: PrismaService,
  user: AuthenticatedUser,
): Promise<OrderScope> {
  if (ORDER_ADMIN_ROLES.includes(String(user.role))) {
    return { admin: true, directLocationIds: [], brandIds: null, allowedLocationIds: [] };
  }
  const [locs, brands] = await Promise.all([
    (prisma as any).userLocation.findMany({
      where: { userId: user.userId },
      select: { locationId: true },
    }),
    (prisma as any).userBrand.findMany({
      where: { userId: user.userId },
      select: { brandId: true },
    }),
  ]);
  const directLocationIds: string[] = locs.map((l: any) => l.locationId as string);
  const brandIds: string[] = brands.map((b: any) => b.brandId as string);

  // Brand-derived locations only widen the *viewable* set (so a requested
  // location filter validates); they don't force a brand filter on orders.
  const allowed = new Set<string>(directLocationIds);
  if (brandIds.length) {
    const brandRows = await prisma.brand.findMany({
      where: { id: { in: brandIds }, tenantId: user.tenantId },
      select: {
        primaryLocationId: true,
        locations: { select: { id: true } },
      },
    });
    for (const b of brandRows) {
      if (b.primaryLocationId) allowed.add(b.primaryLocationId);
      for (const l of b.locations) allowed.add(l.id);
    }
  }

  return {
    admin: false,
    directLocationIds,
    brandIds: brandIds.length ? brandIds : null,
    allowedLocationIds: Array.from(allowed),
  };
}

/**
 * Every location this caller may see orders for, at all — used by the
 * socket gateway's "join every room I'm allowed to see" handler for the
 * "All locations" board, which has no single locationId to join against.
 */
export async function accessibleLocationIdsForRealtime(
  prisma: PrismaService,
  user: AuthenticatedUser,
): Promise<string[]> {
  const scope = await resolveOrderScope(prisma, user);
  if (scope.admin) {
    const locations = await prisma.location.findMany({
      where: { brand: { tenantId: user.tenantId }, deletedAt: null },
      select: { id: true },
    });
    return locations.map((l) => l.id);
  }
  return scope.allowedLocationIds;
}

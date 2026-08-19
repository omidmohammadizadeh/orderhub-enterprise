// "Which shops may this person touch?"
//
// The orders board already answers this (orders/order-access.ts) because it had
// to: a manager at one site was seeing another site's live orders. Every other
// operational area answered a weaker question — "is this location in your
// tenant?" — which is fine while only owners can reach those screens, and stops
// being fine the moment a shop-floor role can.
//
// Inventory and printers both took `locationId` straight from the client and
// checked nothing but the tenant, so opening those tabs to STAFF without this
// would have let a staff member at one shop read and adjust another shop's
// stock, and re-register another shop's printers, just by changing an id in the
// request. This service is the missing half of that change.
//
// The rules are deliberately the SAME ones the orders board uses, imported
// rather than re-implemented, so "my locations" can never come to mean two
// different things in two parts of the product.

import { Injectable, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import {
  accessibleLocationIdsForRealtime,
  ORDER_ADMIN_ROLES,
} from "../../modules/orders/order-access";
import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

@Injectable()
export class LocationAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** True for the roles that see every location in the tenant. NB "OWNER" is
   *  NOT one of them — it is a scoped location-owner role, same as MANAGER and
   *  STAFF. That distinction is set in order-access.ts; don't re-derive it. */
  isTenantWide(user: AuthenticatedUser): boolean {
    return ORDER_ADMIN_ROLES.includes(String(user.role));
  }

  /**
   * Every location id this user may act on: their UserLocation assignments,
   * plus the locations of any brand they're assigned to. Tenant-wide roles get
   * every live location in the tenant.
   */
  async accessibleIds(user: AuthenticatedUser): Promise<string[]> {
    return accessibleLocationIdsForRealtime(this.prisma, user);
  }

  /**
   * The allowlist to filter queries by, or `null` for a tenant-wide role that
   * needs no filter. Returning null rather than "every id" keeps the common
   * admin case from building a huge `IN (...)`.
   */
  async scopeFilter(user: AuthenticatedUser): Promise<string[] | null> {
    if (this.isTenantWide(user)) return null;
    return this.accessibleIds(user);
  }

  /**
   * Refuse a request naming a location this user isn't assigned to.
   *
   * Deliberately a 403 with the same wording whether the location belongs to
   * another tenant or merely another shop in this one — a probe shouldn't be
   * able to tell "doesn't exist" from "not yours".
   */
  async assertAccess(
    user: AuthenticatedUser,
    locationId: string | null | undefined,
  ): Promise<void> {
    if (!locationId) return;
    if (this.isTenantWide(user)) return;
    const allowed = await this.accessibleIds(user);
    if (!allowed.includes(locationId)) {
      throw new ForbiddenException(
        "You don't have access to this location. Ask an owner to assign you to it.",
      );
    }
  }
}

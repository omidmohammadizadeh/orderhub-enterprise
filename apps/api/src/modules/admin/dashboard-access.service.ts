import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  DASHBOARD_ACCESS_SETTINGS_KEY,
  disabledTabsFromSettings,
  normaliseDisabledTabs,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// ── Dashboard access (Admin Dashboard → Dashboard access) ───────────────────
//
// Per-location sidebar visibility. A platform admin picks a location and
// switches off the tabs that location has no use for — a dark kitchen has no
// dining room, so Tables and Reservations shouldn't be on anyone's screen
// there, owner included.
//
// Stored on Location.settings.dashboardAccess.disabledTabs. It lives on the
// LOCATION on purpose: the rule is "nobody at this shop sees this tab",
// which is a property of the shop, not of any user's role. Roles keep
// narrowing on top — this only ever takes tabs away, never grants one.
//
// Writes are admin-only, and LocationsService strips the key from ordinary
// PATCH /locations/:id bodies, so an owner can't hand it back to themselves
// with one curl.

export interface DashboardAccessRow {
  locationId: string;
  locationName: string;
  brandName: string | null;
  disabledTabs: string[];
}

@Injectable()
export class DashboardAccessService {
  private readonly logger = new Logger(DashboardAccessService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every location in the tenant with its current restrictions. */
  async list(tenantId: string): Promise<DashboardAccessRow[]> {
    const rows = await this.prisma.location.findMany({
      where: { deletedAt: null, brand: { tenantId } },
      select: {
        id: true,
        name: true,
        settings: true,
        brand: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    });
    return rows.map((l) => ({
      locationId: l.id,
      locationName: l.name,
      brandName: l.brand?.name ?? null,
      disabledTabs: disabledTabsFromSettings(l.settings),
    }));
  }

  async get(tenantId: string, locationId: string): Promise<DashboardAccessRow> {
    const row = await this.requireLocation(tenantId, locationId);
    return {
      locationId: row.id,
      locationName: row.name,
      brandName: row.brand?.name ?? null,
      disabledTabs: disabledTabsFromSettings(row.settings),
    };
  }

  /**
   * Replace the disabled list for one location. Whole-list PUT rather than
   * add/remove calls: the picker shows every tab at once, so the screen the
   * admin is looking at IS the payload, and two admins can't interleave a
   * half-applied state.
   */
  async set(
    tenantId: string,
    locationId: string,
    disabledTabs: unknown,
    actor: { userId?: string; role?: string } = {},
  ): Promise<DashboardAccessRow> {
    const row = await this.requireLocation(tenantId, locationId);
    const before = disabledTabsFromSettings(row.settings);
    // Unknown and locked keys are dropped here, not rejected: the admin's
    // screen may be a deploy behind, and refusing the whole save over one
    // retired key would lose the other twenty toggles they just set.
    const after = normaliseDisabledTabs(disabledTabs);

    const settings = {
      ...((row.settings as Record<string, unknown> | null) ?? {}),
      [DASHBOARD_ACCESS_SETTINGS_KEY]: { disabledTabs: after },
    };

    await this.prisma.location.update({
      where: { id: locationId },
      data: { settings: settings as any },
    });

    await this.audit(tenantId, locationId, before, after, actor);

    return {
      locationId: row.id,
      locationName: row.name,
      brandName: row.brand?.name ?? null,
      disabledTabs: after,
    };
  }

  /**
   * Copy one location's disabled list onto others. Standing up twenty dark
   * kitchens one toggle at a time is how half of them end up different from
   * the other half.
   *
   * Replaces the targets' lists outright rather than merging: "make these
   * match that one" is the only instruction the button can honestly claim
   * to carry out, and a union would quietly leave a target hiding something
   * the source shows.
   */
  async applyTo(
    tenantId: string,
    sourceLocationId: string,
    locationIds: unknown,
    actor: { userId?: string; role?: string } = {},
  ): Promise<{ applied: number; disabledTabs: string[] }> {
    const source = await this.requireLocation(tenantId, sourceLocationId);
    const disabledTabs = disabledTabsFromSettings(source.settings);

    const requested = Array.isArray(locationIds)
      ? locationIds.filter(
          (id): id is string => typeof id === "string" && id !== sourceLocationId,
        )
      : [];
    if (requested.length === 0) return { applied: 0, disabledTabs };

    // Re-resolve every target against the tenant. Ids arrive from a browser,
    // so the list a client sends is a request, not a fact — an id from
    // another tenant must find nothing here rather than be written to.
    const targets = await this.prisma.location.findMany({
      where: {
        id: { in: requested },
        deletedAt: null,
        brand: { tenantId },
      },
      select: { id: true, settings: true },
    });
    if (targets.length === 0) return { applied: 0, disabledTabs };

    // One transaction: either every shop in the group matches the source or
    // none does. A half-applied copy across a franchise is worse than a
    // failed button, because nothing on screen says which half.
    await this.prisma.$transaction(
      targets.map((t) =>
        this.prisma.location.update({
          where: { id: t.id },
          data: {
            settings: {
              ...((t.settings as Record<string, unknown> | null) ?? {}),
              [DASHBOARD_ACCESS_SETTINGS_KEY]: { disabledTabs },
            } as any,
          },
        }),
      ),
    );

    // Audited per location, not once for the batch: "why can't my staff see
    // Tables?" is asked about one shop, and the answer has to be findable
    // under that shop's id.
    for (const t of targets) {
      await this.audit(
        tenantId,
        t.id,
        disabledTabsFromSettings(t.settings),
        disabledTabs,
        actor,
        { copiedFrom: sourceLocationId },
      );
    }

    return { applied: targets.length, disabledTabs };
  }

  private async requireLocation(tenantId: string, locationId: string) {
    // Scoped through brand.tenantId — Location has no tenantId column of its
    // own, and `location.tenantId` reads as undefined, matching nothing.
    const row = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: {
        id: true,
        name: true,
        settings: true,
        brand: { select: { name: true } },
      },
    });
    if (!row) throw new NotFoundException("Location not found");
    return row;
  }

  /** Best-effort: an audit failure must never lose the admin's save. */
  private async audit(
    tenantId: string,
    locationId: string,
    before: string[],
    after: string[],
    actor: { userId?: string; role?: string },
    extraMeta: Record<string, unknown> = {},
  ) {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          userId: actor.userId ?? null,
          event: "dashboard_access.updated",
          resource: "location",
          resourceId: locationId,
          before: { disabledTabs: before } as any,
          after: { disabledTabs: after } as any,
          meta: { role: actor.role ?? null, ...extraMeta } as any,
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `audit write failed for dashboard access ${locationId}: ${err?.message ?? err}`,
      );
    }
  }
}

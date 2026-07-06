// Phase BA — canonical resolver for "which menu serves (location, channel)".
//
// MenuChannelAssignment rows are the serving truth: one row per
// (locationId, channel, brandId), written by the publish flow. Every
// menu-resolution consumer (POS, storefront, WhatsApp, marketplace
// republish, inventory board) asks here FIRST and only falls back to its
// pre-BA legacy cascade when this returns null — so locations that were
// never re-published (or brand-only menus, which get no assignment rows)
// keep resolving exactly as before.
//
// The assigned menu must still be alive: the auto-schedule worker flips
// Menu.isActive daily, and archived/deleted menus keep their rows only
// until the publish flow cleans them — so a dead menu falls through to
// the legacy cascade rather than serving a stale assignment.

import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface ResolveAssignedMenuArgs {
  locationId: string;
  channel: string;
  /** Hard pin — only this brand's assignment counts (storefront ?brand=
   *  override, marketplace connection brand). */
  brandId?: string;
  /** Soft preference — pick this brand's assignment when several brands
   *  hold the same (location, channel) slot; otherwise latest publish wins. */
  preferBrandId?: string;
  /** POS requires status PUBLISHED; storefront only needs isActive. */
  requirePublished?: boolean;
}

@Injectable()
export class MenuAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveAssignedMenuId(
    args: ResolveAssignedMenuArgs,
  ): Promise<string | null> {
    const { locationId, channel, brandId, preferBrandId, requirePublished } =
      args;
    const rows = await this.prisma.menuChannelAssignment.findMany({
      where: {
        locationId,
        channel,
        ...(brandId ? { brandId } : {}),
      },
      orderBy: { publishedAt: "desc" },
      include: {
        menu: {
          select: { id: true, isActive: true, status: true, deletedAt: true },
        },
      },
    });

    const alive = rows.filter(
      (r) =>
        r.menu &&
        r.menu.deletedAt === null &&
        r.menu.isActive &&
        (!requirePublished || r.menu.status === "PUBLISHED"),
    );
    if (alive.length === 0) return null;

    if (preferBrandId) {
      const preferred = alive.find((r) => r.brandId === preferBrandId);
      if (preferred) return preferred.menuId;
    }
    return alive[0]?.menuId ?? null;
  }
}

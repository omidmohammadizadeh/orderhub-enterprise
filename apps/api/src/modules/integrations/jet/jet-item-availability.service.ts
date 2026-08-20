import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { JetClientService } from "./jet-client.service";

// Phase JE-4 — 86 an item on Just Eat.
//
//   POST /item-availability
//   { event: AVAILABLE|UNAVAILABLE, itemReferences: [...], restaurant,
//     happenedAt?, nextAvailableAt? }
//
// TWO THINGS THIS GETS RIGHT THAT COST US ELSEWHERE
//
// 1. THE REFERENCES MUST MATCH WHAT WE PUBLISHED. HubRise's 86 silently
//    no-opped for weeks because the sku_ref it sent was built differently from
//    the one the publish transform emitted — a 200 against a ref the catalog
//    had never heard of. Here the references are derived by exactly the same
//    rule jet-menu.transformer uses (`plu || row id`, and per size
//    `sku.plu || <itemId>__s<n>`), and a product's sizes are ALL sent
//    alongside it: 86ing a pizza has to take every size off, not just the
//    parent row nobody orders directly.
//
// 2. JET HAS A REAL EXPIRY. `nextAvailableAt` means a timed snooze restores
//    itself on their side, so we do not inherit Deliveroo's caveat where a
//    snooze that expires never pushes back. It is only valid on UNAVAILABLE
//    and must be in the future, both of which are enforced here.

@Injectable()
export class JetItemAvailabilityService {
  private readonly logger = new Logger(JetItemAvailabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: JetClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /**
   * The item references we published for this product.
   *
   * MUST stay in step with jet-menu.transformer's `pluFor`. If the two ever
   * disagree, JET accepts the request and changes nothing — the failure is
   * silent, which is precisely how the HubRise version hid for weeks.
   */
  static referencesFor(item: {
    id: string;
    plu?: string | null;
    hasMultipleSkus?: boolean | null;
    productSkus?: unknown;
  }): string[] {
    const refs = [String(item.plu ?? "").trim() || item.id];
    if (item.hasMultipleSkus && Array.isArray(item.productSkus)) {
      (item.productSkus as any[]).forEach((sku, i) => {
        if (!sku || typeof sku.name !== "string") return;
        refs.push(String(sku.plu ?? "").trim() || `${item.id}__s${i}`);
      });
    }
    // A product and one of its sizes can share a PLU; sending it twice is
    // harmless but noisy in the logs.
    return Array.from(new Set(refs));
  }

  /**
   * Push one item's availability to every Just Eat restaurant serving it.
   *
   * Resolution mirrors the Deliveroo path: the MenuChannelAssignment rows are
   * authoritative, with the pre-assignment `publishedTo` lookup kept as a
   * fallback for tenants who have not re-published since. A location-scoped
   * 86 touches only that location's restaurant; a global one touches them all.
   */
  async pushItemAvailability(args: {
    tenantId: string;
    itemId: string;
    available: boolean;
    /** When the item comes back. Ignored on AVAILABLE; must be in the future. */
    until?: Date | null;
    locationId?: string;
  }): Promise<void> {
    const item = await this.prisma.menuItem.findUnique({
      where: { id: args.itemId },
      select: {
        id: true,
        name: true,
        plu: true,
        brandId: true,
        hasMultipleSkus: true,
        productSkus: true,
      },
    });
    if (!item) return;

    const targets = await this.resolveTargets(args.tenantId, args.itemId, args.locationId);
    if (targets.length === 0) {
      this.logger.log(
        `JET 86 skip: item ${args.itemId} isn't on a Just Eat-published menu`,
      );
      return;
    }

    const itemReferences = JetItemAvailabilityService.referencesFor(item);
    // `nextAvailableAt` is UNAVAILABLE-only and must be in the future. A
    // snooze whose expiry has already passed is a restore, not a 86 — sending
    // a past timestamp is a 400 and would drop the update entirely.
    const nextAvailableAt =
      !args.available && args.until && args.until.getTime() > Date.now()
        ? args.until.toISOString()
        : null;

    for (const target of targets) {
      const body: Record<string, unknown> = {
        event: args.available ? "AVAILABLE" : "UNAVAILABLE",
        itemReferences,
        restaurant: target.restaurantReference,
        happenedAt: new Date().toISOString(),
        ...(nextAvailableAt ? { nextAvailableAt } : {}),
      };

      try {
        await this.client.request("POST", "/item-availability", {
          keyType: "menu",
          brandId: target.brandId,
          locationId: target.locationId,
          country: target.country,
          body,
          retries: 2,
        });
        this.logger.log(
          `JET 86 ${args.available ? "IN" : "OUT"} restaurant ${target.restaurantReference}: ` +
            `${itemReferences.join(",")}` +
            (nextAvailableAt ? ` until ${nextAvailableAt}` : ""),
        );
        this.activity?.record({
          tenantId: args.tenantId,
          brandId: target.brandId,
          locationId: target.locationId,
          category: "INVENTORY",
          channel: "JUST_EAT",
          action: args.available ? "item.restore.push" : "item.86.push",
          status: "SUCCESS",
          message: `"${item.name}" marked ${args.available ? "available" : "unavailable"} on Just Eat`,
          details: { itemReferences, restaurant: target.restaurantReference, nextAvailableAt },
        });
      } catch (err: any) {
        this.logger.warn(
          `JET 86 failed for restaurant ${target.restaurantReference}: ${err?.message}`,
        );
        this.activity?.record({
          tenantId: args.tenantId,
          brandId: target.brandId,
          locationId: target.locationId,
          category: "INVENTORY",
          channel: "JUST_EAT",
          action: args.available ? "item.restore.push" : "item.86.push",
          status: "ERROR",
          message: `Just Eat availability push failed for "${item.name}": ${err?.message}`,
          details: { itemReferences, restaurant: target.restaurantReference },
        });
      }
    }
  }

  /** Every connected JET restaurant serving a menu that contains this item. */
  private async resolveTargets(
    tenantId: string,
    itemId: string,
    locationId?: string,
  ): Promise<
    Array<{
      brandId: string;
      locationId: string;
      restaurantReference: string;
      country: string | null;
    }>
  > {
    const assignments = await (this.prisma as any).menuChannelAssignment.findMany({
      where: {
        channel: "JUST_EAT",
        ...(locationId ? { locationId } : {}),
        menu: {
          deletedAt: null,
          isActive: true,
          brand: { tenantId },
          categories: { some: { items: { some: { itemId } } } },
        },
      },
      select: { brandId: true, locationId: true },
    });

    let scopes: Array<{ brandId: string; locationId: string | null }> = assignments.map(
      (a: any) => ({ brandId: a.brandId, locationId: a.locationId }),
    );

    if (scopes.length === 0) {
      // Pre-assignment fallback: a menu holding this item that was published
      // to Just Eat. Resolved by the MENU's brand rather than the item's — in
      // a multi-brand kitchen those differ, and it is the menu's brand that
      // owns the connection.
      const menu = await this.prisma.menu.findFirst({
        where: {
          deletedAt: null,
          publishedTo: { has: "JUST_EAT" },
          brand: { tenantId },
          categories: { some: { items: { some: { itemId } } } },
        },
        orderBy: { lastPublishedAt: "desc" },
        select: { brandId: true, locationId: true },
      });
      if (!menu) return [];
      scopes = [{ brandId: menu.brandId, locationId: locationId ?? menu.locationId }];
    }

    const out = new Map<string, any>();
    for (const scope of scopes) {
      const conn = await this.prisma.brandPlatformConnection.findFirst({
        where: {
          platform: "JUST_EAT",
          tenantId,
          brandId: scope.brandId,
          status: { not: "not_connected" },
          ...(scope.locationId ? { locationId: scope.locationId } : {}),
        },
        select: {
          brandId: true,
          locationId: true,
          externalStoreId: true,
          metadata: true,
        },
      });
      if (!conn) continue;
      const metadata = (conn.metadata ?? {}) as Record<string, any>;
      const restaurantReference =
        (metadata.restaurantReference ?? "").trim?.() || conn.externalStoreId;
      if (!restaurantReference) continue;
      // One push per restaurant, even when several menus resolve to it.
      out.set(restaurantReference, {
        brandId: conn.brandId,
        locationId: conn.locationId,
        restaurantReference,
        country: metadata.country ?? null,
      });
    }
    return Array.from(out.values());
  }
}

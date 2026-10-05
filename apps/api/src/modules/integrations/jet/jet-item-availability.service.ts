import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
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
// 2. WE OWN THE EXPIRY, NOT THEM. Their docs describe a `nextAvailableAt` that
//    restores the item on their side. We no longer send it, and `sweepExpired`
//    below puts the item back instead — the same way Glovo and Keeta work.
//
//    WHY. On 2 Oct 2026 three 86s went out within half an hour. The two that
//    took effect carried no expiry; the one that did not was the only one
//    carrying `nextAvailableAt`:
//      434799 OUT PROD-65ATHH                                  -> applied
//      440823 OUT PROD-CHAMQT,...__s0..__s3                     -> applied
//      302649 OUT Berrylicious until 2026-10-03T09:00:00.000Z    -> did not
//    Everything else about the third was verified good: the reference matched
//    `pluFor`, the menu ingest for that restaurant had succeeded four minutes
//    earlier on the same key, and JET answered 202. `nextAvailableAt` was the
//    only field that differed, and it is OUR READING OF THEIR PROSE — we have
//    never seen a call they demonstrably honoured with it. So the 86 now goes
//    in the shape that is proven to work, and the restore is ours to do.
//
// 3. THE BOARD'S ROW IS NOT ALWAYS THE PUBLISHED ROW. See `allReferencesFor`.
//    Point 1 is necessary but not sufficient: building the reference correctly
//    still sends the WRONG reference if the published menu holds a different
//    twin of the same product. HubRise learned this the expensive way; this
//    path now fans out the same way.

@Injectable()
export class JetItemAvailabilityService {
  private readonly logger = new Logger(JetItemAvailabilityService.name);
  /** Restores are swept forward from here. Ten minutes back so a restart
   *  re-covers the window it missed; a duplicate restore is harmless. */
  private sweptUntil = new Date(Date.now() - 10 * 60_000);

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
      // Filter BEFORE numbering, exactly as jet-menu-publish.readSkus does.
      // Walking the raw array and skipping invalid entries left the counter
      // running, so one null or unnamed size renumbered every size after it:
      // published as __s0, 86'd as __s1, and JET answers 202 either way.
      (item.productSkus as any[])
        .filter((sku) => sku && typeof sku.name === "string")
        .forEach((sku, i) => {
          refs.push(String(sku.plu ?? "").trim() || `${item.id}__s${i}`);
        });
    }
    // A product and one of its sizes can share a PLU; sending it twice is
    // harmless but noisy in the logs.
    return Array.from(new Set(refs));
  }

  /**
   * Every reference Just Eat could be holding for this product: the row the
   * inventory board 86'd, plus every same-brand same-name twin of it.
   *
   * WHY TWINS EXIST. One product is often SEVERAL MenuItem rows — a master menu
   * is composed from per-brand source menus, and cloning a menu into a location
   * mints a fresh row with its own PLU. The board dedups them and snoozes ONE,
   * but the menu we published to a given restaurant may hold a DIFFERENT twin.
   * The reference is then built perfectly and still names a product JET's
   * catalog has never heard of, and because JET answers 202 and applies the
   * update asynchronously, nothing anywhere reports a miss.
   *
   * The asymmetry is real and was found on 2 Oct 2026: one click on
   * "Berrylicious" at Jinty's sent three references to HubRise and one to JET.
   *   HubRise 86 -> ... OUT Berrylicious, PROD-NYLM32, PROD-KMVK7U
   *   JET 86 OUT restaurant 302649: Berrylicious
   * HubRise covered all three because the identical bug was found and fixed
   * there first; this path sent only the row the board happened to show.
   *
   * NOT the cause of that day's miss, to be clear — the reference JET got was
   * the right one (the menu ingest for 302649 succeeded on the same key, so the
   * live catalog held `Berrylicious`). This is the latent bug next door, closed
   * before it bites a brand whose published twin differs.
   *
   * SAFETY. Sending references a catalog does not contain is a no-op on JET's
   * side — which is precisely why the miss was silent — so the fan-out can only
   * ever hit the row that was actually published. It cannot 86 a different
   * product: twins are matched on the same brand AND the same name, which is
   * the same rule the HubRise path has used in production for months.
   */
  private async allReferencesFor(item: {
    id: string;
    name: string;
    brandId: string | null;
    plu?: string | null;
    hasMultipleSkus?: boolean | null;
    productSkus?: unknown;
  }): Promise<string[]> {
    const refs = JetItemAvailabilityService.referencesFor(item);
    if (!item.brandId || !item.name) return refs;

    const twins = await this.prisma.menuItem.findMany({
      where: {
        id: { not: item.id },
        brandId: item.brandId,
        name: { equals: item.name, mode: "insensitive" },
      },
      select: {
        id: true,
        plu: true,
        hasMultipleSkus: true,
        productSkus: true,
      },
    });

    const all = [...refs];
    for (const twin of twins) {
      all.push(...JetItemAvailabilityService.referencesFor(twin));
    }
    // The board's own row stays FIRST: it is the one a human would recognise
    // in the log line, and it is the likeliest match.
    return Array.from(new Set(all));
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

    const itemReferences = await this.allReferencesFor(item);
    // The expiry is recorded for the log line and for `sweepExpired` to act on
    // later. It is deliberately NOT put in the body — see point 2 in the file
    // header. A snooze whose expiry has already passed is a restore, not an 86.
    const until =
      !args.available && args.until && args.until.getTime() > Date.now()
        ? args.until.toISOString()
        : null;

    for (const target of targets) {
      const body: Record<string, unknown> = {
        event: args.available ? "AVAILABLE" : "UNAVAILABLE",
        itemReferences,
        restaurant: target.restaurantReference,
        happenedAt: new Date().toISOString(),
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
            (until ? ` until ${until} (restored by our sweep)` : ""),
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
          details: { itemReferences, restaurant: target.restaurantReference, until },
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

  /**
   * Put items back on sale when their timed snooze runs out.
   *
   * This is the other half of not sending `nextAvailableAt` (file header,
   * point 2): having taken the expiry out of their hands, we have to honour it
   * ourselves, or "off until 9am tomorrow" would mean "off until a human
   * notices". Same shape as Glovo's and Keeta's sweeps.
   *
   * Only rows that expired SINCE THE LAST SWEEP, so an item is restored once
   * rather than every thirty seconds for the rest of the day.
   */
  @Cron("30 * * * * *")
  async sweepExpired(): Promise<number> {
    const from = this.sweptUntil;
    const to = new Date();
    this.sweptUntil = to;

    const rows = await (this.prisma as any).menuItemChannelAvailability
      .findMany({
        where: {
          channel: { in: ["JUST_EAT", "ALL"] },
          expiresAt: { gt: from, lte: to },
        },
        select: { itemId: true, locationId: true, item: { select: { brandId: true } } },
        take: 500,
      })
      .catch(() => []);
    if (rows.length === 0) return 0;

    // The push needs a tenant, and the row only carries the brand.
    const brandIds = Array.from(
      new Set(rows.map((r: any) => r?.item?.brandId).filter(Boolean)),
    ) as string[];
    const brands = brandIds.length
      ? await this.prisma.brand.findMany({
          where: { id: { in: brandIds } },
          select: { id: true, tenantId: true },
        })
      : [];
    const tenantOf = new Map(brands.map((b) => [b.id, b.tenantId]));

    // Counts restores PUSHED, not restores JET confirmed: pushItemAvailability
    // deliberately swallows a per-restaurant HTTP failure (and logs it) so one
    // unreachable store cannot strand the rest of the sweep. The catch below is
    // for the push failing outright — a database error before it gets that far.
    let pushed = 0;
    for (const row of rows) {
      const tenantId = tenantOf.get(row?.item?.brandId);
      if (!tenantId) continue;
      // One bad item must not strand the rest of the sweep.
      await this.pushItemAvailability({
        tenantId,
        itemId: row.itemId,
        available: true,
        ...(row.locationId ? { locationId: row.locationId } : {}),
      })
        .then(() => {
          pushed += 1;
        })
        .catch((err: any) =>
          this.logger.warn(
            `JET restore after expiry failed for item ${row.itemId}: ${err?.message}`,
          ),
        );
    }
    if (pushed > 0) {
      this.logger.log(`JET: pushed a restore for ${pushed} expired snooze(s)`);
    }
    return pushed;
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

import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { currencyForCountry } from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CareemClientService } from "./careem-client.service";
import {
  transformCareemMenu,
  type CareemMenuProblem,
  type CareemPriceUnit,
  type SourceGroup,
  type SourceMenu,
} from "./careem-menu.transformer";

// Phase CA-3 — push a menu to Careem.
//
// The push is ASYNCHRONOUS. PUT /catalogs returns a request_id immediately and
// the outcome arrives minutes later, either by polling
// GET /catalogs/status/{request_id} or on the CATALOG_REQUEST_STATUS_UPDATED
// webhook. A 200 here means "accepted for processing", not "live" — about five
// minutes to appear on the SuperApp, per their docs. Treating the 200 as
// success is the same mistake JET's /menus 202 invites.
//
// Rate limits are theirs and tight: one sync per branch every two minutes, 50
// a minute across all branches. The two-minute one is enforced here, because
// hitting it returns a 409 that reads like a conflict rather than a throttle.

/** Careem's per-branch floor between syncs. */
const MIN_SYNC_INTERVAL_MS = 2 * 60_000;

/** Careem's FAQ gives UAE and KSA. Jordan is theirs to confirm. */
/** Careem's own ceiling, separate from the two-minute per-branch floor. */
const MAX_SYNCS_PER_MINUTE = 50;

const VAT_BY_COUNTRY: Record<string, number> = { AE: 5, SA: 15, JO: 16 };

@Injectable()
export class CareemMenuPublishService {
  private readonly logger = new Logger(CareemMenuPublishService.name);
  /** Last push per branch, to honour their two-minute floor. */
  private readonly lastSync = new Map<string, number>();
  /** Push timestamps across EVERY branch, for their second, separate cap. */
  private readonly recentSyncs: number[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CareemClientService,
  ) {}

  /**
   * Which unit Careem wants prices in.
   *
   * Unresolved: their schema says `integer` and never says of what. Their
   * example shows `"price": 20`, which reads as whole dirhams, but an integer
   * in whole dirhams cannot express 11.50 — which a real menu is full of. The
   * transformer refuses to round, so a wrong setting here fails loudly with
   * the offending items named rather than silently mispricing a menu by 100×.
   */
  private get priceUnit(): CareemPriceUnit {
    return process.env.CAREEM_PRICE_UNIT === "minor" ? "minor" : "major";
  }

  /**
   * Publish a location's menu to its Careem branch.
   *
   * Returns the request id to track, or the reasons we refused to send.
   */
  async publish(
    locationId: string,
    tenantId?: string,
  ): Promise<
    { ok: true; requestId: string } | { ok: false; errors: CareemMenuProblem[] }
  > {
    const since = Date.now() - (this.lastSync.get(locationId) ?? 0);
    if (since < MIN_SYNC_INTERVAL_MS) {
      throw new BadRequestException(
        `Careem allows one catalog sync per branch every 2 minutes. Try again in ` +
          `${Math.ceil((MIN_SYNC_INTERVAL_MS - since) / 1000)}s.`,
      );
    }

    // Their second limit, which the per-branch floor does not cover: 50
    // catalog syncs a minute across all branches. A chain republishing every
    // shop at once is exactly how that gets hit, and a 429 costs the whole
    // batch rather than the one over the line.
    const minuteAgo = Date.now() - 60_000;
    while (this.recentSyncs.length && this.recentSyncs[0]! < minuteAgo) {
      this.recentSyncs.shift();
    }
    if (this.recentSyncs.length >= MAX_SYNCS_PER_MINUTE) {
      throw new BadRequestException(
        `Careem allow ${MAX_SYNCS_PER_MINUTE} catalog syncs a minute across all ` +
          `branches. Try again shortly.`,
      );
    }

    const menu = await this.loadMenu(locationId, tenantId);
    const { payload, errors } = transformCareemMenu(menu, {
      unit: this.priceUnit,
      branchId: locationId,
    });

    if (!payload) {
      // Refused before the round trip. Careem's own validation would reject
      // most of this five minutes later with a message that names neither the
      // entity nor the id.
      this.logger.warn(
        `Careem publish for ${locationId} refused with ${errors.length} problem(s)`,
      );
      return { ok: false, errors };
    }

    const brandId = await this.brandIdFor(locationId, tenantId);
    const res = await this.client.request<{ request_id?: string }>("/catalogs", {
      method: "PUT",
      branchId: locationId,
      ...(brandId ? { brandId } : {}),
      body: payload,
    });
    this.lastSync.set(locationId, Date.now());
    this.recentSyncs.push(Date.now());

    const requestId = String(res?.request_id ?? "");
    this.logger.log(
      `Careem catalog accepted for ${locationId} as request ${requestId} — ` +
        `NOT live yet, ~5 minutes to appear on the SuperApp`,
    );
    return { ok: true, requestId };
  }

  /**
   * Build the catalog without sending it.
   *
   * The transformer makes every decision that can go wrong — the price unit,
   * their group min/max rules, which items are publishable at all — and all of
   * them are cheaper to read here than to discover from a rejection five
   * minutes after an upload.
   */
  async dryRun(locationId: string, tenantId?: string) {
    const menu = await this.loadMenu(locationId, tenantId);
    const { payload, errors } = transformCareemMenu(menu, {
      unit: this.priceUnit,
      branchId: locationId,
    });
    return {
      wouldPublish: !!payload,
      problems: errors,
      counts: {
        categories: payload?.categories.length ?? 0,
        items: payload?.items.length ?? 0,
        groups: payload?.groups.length ?? 0,
        options: payload?.options.length ?? 0,
      },
      payload,
    };
  }

  /**
   * Careem RETIRED this on 24 April 2024.
   *
   * Kept, and kept behind a flag, because their own FAQ says a partner "may
   * request an approval for consuming the endpoint" — so it is disabled
   * rather than gone. Without that approval it answers API_DEPRECATED_ERROR.
   *
   * The replacement is the ordinary publish: our push is always diff:false, a
   * full replace, and Careem delete whatever the payload omits. That already
   * does what a reset was for.
   */
  async resetCatalog(locationId: string, tenantId?: string) {
    if (process.env.CAREEM_ALLOW_CATALOG_RESET !== "true") {
      throw new BadRequestException(
        "Careem deprecated DELETE /catalogs on 24 April 2024 and it returns " +
          "API_DEPRECATED_ERROR. Publish the menu instead — our push is a full " +
          "replace, so it clears anything Careem still hold. If Careem have " +
          "approved this endpoint for us, set CAREEM_ALLOW_CATALOG_RESET=true.",
      );
    }
    if (tenantId) await this.assertOwned(locationId, tenantId);
    const brandId = await this.brandIdFor(locationId, tenantId);
    await this.client.request("/catalogs", {
      method: "DELETE",
      branchId: locationId,
      ...(brandId ? { brandId } : {}),
    });
    return {
      ok: true,
      note:
        "Nothing is gone yet. Careem only drop the old catalog when the next " +
        "full push arrives — publish the menu to complete the reset.",
    };
  }

  /** Poll one catalog request. The webhook says the same thing unprompted;
   *  this exists for when it hasn't arrived and someone is watching. */
  async status(locationId: string, requestId: string, tenantId?: string) {
    if (tenantId) await this.assertOwned(locationId, tenantId);
    return this.client.request(`/catalogs/status/${encodeURIComponent(requestId)}`, {
      method: "GET",
      branchId: locationId,
    });
  }

  /**
   * Snooze or restore items — Careem's 86 endpoint.
   *
   * Capped at 40 per call by them, so callers with more must chunk; doing it
   * silently here would hide that a bulk change was split and partly failed.
   */
  async setItemAvailability(
    locationId: string,
    catalogId: string,
    items: Array<{ id: string; active: boolean }>,
  ): Promise<void> {
    if (items.length > 40) {
      throw new BadRequestException(
        `Careem accepts at most 40 items per availability call (got ${items.length}).`,
      );
    }
    await this.client.request(
      `/catalogs/${encodeURIComponent(catalogId)}/items`,
      {
        method: "PATCH",
        branchId: locationId,
        body: {
          items: items.map((i) => ({
            id: i.id,
            status: i.active ? "active" : "inactive",
          })),
        },
      },
    );
  }

  private async brandIdFor(
    locationId: string,
    tenantId?: string,
  ): Promise<string | null> {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, ...(tenantId ? { brand: { tenantId } } : {}) },
      select: { brandId: true },
    });
    return loc?.brandId ?? null;
  }

  /** Locations carry no tenantId of their own — they hang off the brand.
   *  Anything reachable from a browser has to check this. */
  private async assertOwned(locationId: string, tenantId: string) {
    const owned = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true },
    });
    if (!owned) throw new BadRequestException("Location not found");
  }

  /**
   * Assemble the menu in the shape the transformer wants.
   *
   * Only what Careem can express: visible categories, available items, and the
   * modifier groups those items actually reference. Publishing a hidden item
   * would put it on the SuperApp where nobody here expects to see it.
   */
  private async loadMenu(
    locationId: string,
    tenantId?: string,
  ): Promise<SourceMenu> {
    const location = await this.prisma.location.findFirst({
      where: {
        id: locationId,
        deletedAt: null,
        ...(tenantId ? { brand: { tenantId } } : {}),
      },
      select: { id: true, name: true, brandId: true, country: true },
    });
    if (!location) throw new BadRequestException("Location not found");

    const menu = await this.prisma.menu.findFirst({
      where: { brandId: location.brandId, isActive: true },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!menu) throw new BadRequestException("No active menu for this brand");

    const categories = await this.prisma.menuCategory.findMany({
      where: { menuId: menu.id, isVisible: true },
      orderBy: { sortOrder: "asc" },
      include: {
        items: { orderBy: { sortOrder: "asc" }, include: { item: true } },
      },
    });

    const items: SourceMenu["items"] = [];
    const sourceCategories: SourceMenu["categories"] = [];
    const seen = new Set<string>();

    for (const category of categories) {
      const itemIds: string[] = [];
      for (const link of category.items) {
        const item = link.item;
        if (!item || !item.visibleToCustomers) continue;
        itemIds.push(item.id);
        if (seen.has(item.id)) continue; // an item can sit in several categories
        seen.add(item.id);
        items.push({
          id: item.id,
          name: item.name,
          secondLanguageName: item.secondLanguageName,
          description: item.description,
          basePrice: Number(item.basePrice),
          // 86'd items publish as inactive rather than vanishing, so the
          // SuperApp shows them greyed out and the next sync can restore them.
          isAvailable: item.isAvailable && !item.outOfStock,
          imageUrl: item.imageUrl,
          calories: item.calories,
          allergens: item.allergens ?? [],
          sortOrder: link.sortOrder ?? 0,
          groupIds: [],
        });
      }
      sourceCategories.push({
        id: category.id,
        name: category.name,
        secondLanguageName: category.secondLanguageName,
        description: category.description,
        sortOrder: category.sortOrder,
        itemIds,
      });
    }

    const groups = await this.loadGroups(location.brandId, items);

    return {
      id: menu.id,
      name: menu.name,
      country: location.country,
      // Careem want their own integer for the currency; the transformer maps
      // it and refuses a currency they have no id for.
      currency: currencyForCountry(location.country),
      // Careem prices INCLUDE tax — this is the rate baked into them, not one
      // to add. Their FAQ states UAE 5% and KSA 15%. Jordan is the third
      // country they serve and they never gave a figure for it; 16% is its
      // standard sales tax. Wrong here misreports the split, not the price.
      taxPercentage: VAT_BY_COUNTRY[location.country] ?? 5,
      categories: sourceCategories,
      items,
      groups,
    };
  }

  /** The groups those items use, plus any groups nested under their options —
   *  Careem takes nested modifiers, so the walk has to follow them down. */
  private async loadGroups(
    brandId: string,
    items: SourceMenu["items"],
  ): Promise<SourceGroup[]> {
    const links = await (this.prisma as any).menuItemModifierGroup.findMany({
      where: { menuItemId: { in: items.map((i) => i.id) } },
      select: { menuItemId: true, modifierGroupId: true },
    });
    const byItem = new Map<string, string[]>();
    for (const l of links as Array<{ menuItemId: string; modifierGroupId: string }>) {
      byItem.set(l.menuItemId, [...(byItem.get(l.menuItemId) ?? []), l.modifierGroupId]);
    }
    for (const item of items) item.groupIds = byItem.get(item.id) ?? [];

    const out = new Map<string, SourceGroup>();
    let frontier = [...new Set(items.flatMap((i) => i.groupIds))];

    while (frontier.length) {
      const rows = await this.prisma.modifierGroup.findMany({
        where: { id: { in: frontier }, brandId },
        include: {
          options: { where: { isAvailable: true }, orderBy: { sortOrder: "asc" } },
        },
      });
      const next: string[] = [];
      for (const g of rows) {
        if (out.has(g.id)) continue;
        out.set(g.id, {
          id: g.id,
          name: g.name,
          secondLanguageName: g.secondLanguageName,
          description: g.description,
          minSelections: g.minSelections,
          maxSelections: g.maxSelections,
          isRequired: g.isRequired,
          sortOrder: g.sortOrder,
          selectionType: g.selectionType === "ADDON" ? "ADDON" : "VARIANT",
          options: g.options.map((o) => {
            const nested = (o.modifierGroupIds ?? []) as string[];
            next.push(...nested);
            return {
              id: o.id,
              name: o.name,
              secondLanguageName: o.secondLanguageName,
              priceAdjustment: Number(o.priceAdjustment),
              isAvailable: o.isAvailable,
              sortOrder: o.sortOrder,
              ...(nested.length ? { groupIds: nested } : {}),
            };
          }),
        });
      }
      frontier = next.filter((id) => !out.has(id));
    }
    return [...out.values()];
  }
}

import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase BF — variant-menu publish for direct channels. Lets a menu's
// (location, channel, brand) publish slot price itself from a NAMED PRICING
// VARIANT defined on a DIFFERENT ("source") menu — e.g. one central menu
// holds every brand's per-channel prices (the "Variant menu"), and every
// other menu's Uber Eats/Deliveroo/WhatsApp/Online publish can point at it
// instead of re-entering prices. This is genuinely new: HubRise's existing
// variant publish (hubrise-catalog.service.ts) only ever reads overrides
// from the SAME menu being published — nothing before this resolved a
// variant from a different menu.
//
// Items are matched across the two menus by externalId, falling back to a
// normalised name match — the same strategy ordering.service.ts's
// anchorPromoItemsToServedMenu uses for campaign items, so a locally
// created item (no externalId) still matches by name.

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export class VariantPriceMap {
  constructor(
    private readonly itemByExternal: Map<string, number>,
    private readonly itemByName: Map<string, number>,
    private readonly skuByExternal: Map<string, number>,
    private readonly skuByName: Map<string, number>,
    private readonly optionByExternal: Map<string, number>,
    private readonly optionByName: Map<string, number>,
  ) {}

  /** Override price for an item's base price, or undefined = keep its own price. */
  itemPrice(item: { externalId?: string | null; name?: string | null }): number | undefined {
    if (item.externalId && this.itemByExternal.has(String(item.externalId))) {
      return this.itemByExternal.get(String(item.externalId));
    }
    const key = norm(item.name);
    return key ? this.itemByName.get(key) : undefined;
  }

  /** Override price for one size/SKU of a multi-SKU item. */
  skuPrice(
    item: { externalId?: string | null; name?: string | null },
    sku: { plu?: string | null; name?: string | null },
  ): number | undefined {
    const itemKey = item.externalId ? `ext:${item.externalId}` : `name:${norm(item.name)}`;
    if (sku.plu) {
      const k = `${itemKey}::${sku.plu}`;
      if (this.skuByExternal.has(k)) return this.skuByExternal.get(k);
    }
    const nameKey = `${itemKey}::${norm(sku.name)}`;
    return this.skuByName.get(nameKey);
  }

  /** Override price for a modifier option. */
  optionPrice(opt: { externalId?: string | null; name?: string | null }): number | undefined {
    if (opt.externalId && this.optionByExternal.has(String(opt.externalId))) {
      return this.optionByExternal.get(String(opt.externalId));
    }
    const key = norm(opt.name);
    return key ? this.optionByName.get(key) : undefined;
  }
}

@Injectable()
export class VariantPriceResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build a price lookup for `variantRef` from `sourceMenuId`'s items, SKUs,
   * and modifier options. An item/SKU/option with no override for this
   * specific variant simply has no entry — callers fall back to whatever
   * price they'd otherwise have used.
   */
  async buildPriceMap(sourceMenuId: string, variantRef: string): Promise<VariantPriceMap> {
    const menu = await this.prisma.menu.findUnique({
      where: { id: sourceMenuId },
      select: {
        categories: {
          select: {
            items: {
              select: {
                item: {
                  select: {
                    id: true,
                    name: true,
                    externalId: true,
                    hasMultipleSkus: true,
                    productSkus: true,
                    platformPricingOverrides: true,
                    modifierGroupLinks: {
                      select: {
                        group: {
                          select: {
                            options: {
                              select: {
                                name: true,
                                externalId: true,
                                platformPricingOverrides: true,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const itemByExternal = new Map<string, number>();
    const itemByName = new Map<string, number>();
    const skuByExternal = new Map<string, number>();
    const skuByName = new Map<string, number>();
    const optionByExternal = new Map<string, number>();
    const optionByName = new Map<string, number>();

    const seenItemIds = new Set<string>();
    const seenOptionKeys = new Set<string>();

    for (const cat of menu?.categories ?? []) {
      for (const link of cat.items ?? []) {
        const it = (link as any).item;
        if (!it || seenItemIds.has(it.id)) continue;
        seenItemIds.add(it.id);

        const itemOverrides = (it.platformPricingOverrides ?? {}) as Record<string, number>;
        const itemPrice = itemOverrides?.[variantRef];
        if (typeof itemPrice === "number" && Number.isFinite(itemPrice)) {
          if (it.externalId) itemByExternal.set(String(it.externalId), itemPrice);
          const key = norm(it.name);
          if (key && !itemByName.has(key)) itemByName.set(key, itemPrice);
        }

        const itemKey = it.externalId ? `ext:${it.externalId}` : `name:${norm(it.name)}`;
        if (it.hasMultipleSkus && Array.isArray(it.productSkus)) {
          for (const sku of it.productSkus as any[]) {
            const skuOverrides = (sku?.priceOverrides ?? {}) as Record<string, number>;
            const skuPrice = skuOverrides?.[variantRef];
            if (typeof skuPrice === "number" && Number.isFinite(skuPrice)) {
              if (sku.plu) skuByExternal.set(`${itemKey}::${sku.plu}`, skuPrice);
              const nameKey = `${itemKey}::${norm(sku.name)}`;
              if (!skuByName.has(nameKey)) skuByName.set(nameKey, skuPrice);
            }
          }
        }

        for (const gl of it.modifierGroupLinks ?? []) {
          for (const opt of gl.group?.options ?? []) {
            const optKey = opt.externalId ?? norm(opt.name);
            if (seenOptionKeys.has(optKey)) continue;
            seenOptionKeys.add(optKey);
            const optOverrides = (opt.platformPricingOverrides ?? {}) as Record<string, number>;
            const optPrice = optOverrides?.[variantRef];
            if (typeof optPrice === "number" && Number.isFinite(optPrice)) {
              if (opt.externalId) optionByExternal.set(String(opt.externalId), optPrice);
              const key = norm(opt.name);
              if (key && !optionByName.has(key)) optionByName.set(key, optPrice);
            }
          }
        }
      }
    }

    return new VariantPriceMap(
      itemByExternal,
      itemByName,
      skuByExternal,
      skuByName,
      optionByExternal,
      optionByName,
    );
  }

  /**
   * Convenience: look up the (location, channel, brand) assignment and
   * return its variant price map, or null when this slot isn't configured
   * for variant-menu publish (the caller should fall back to normal
   * pricing — this is opt-in per slot, not a replacement for it).
   */
  async forAssignment(args: {
    tenantId?: string;
    locationId: string;
    channel: string;
    brandId: string;
  }): Promise<VariantPriceMap | null> {
    const assignment = await (this.prisma as any).menuChannelAssignment.findUnique({
      where: {
        locationId_channel_brandId: {
          locationId: args.locationId,
          channel: args.channel,
          brandId: args.brandId,
        },
      },
      select: { variantSourceMenuId: true, variantRef: true },
    });
    if (!assignment?.variantSourceMenuId || !assignment?.variantRef) return null;
    return this.buildPriceMap(assignment.variantSourceMenuId, assignment.variantRef);
  }
}

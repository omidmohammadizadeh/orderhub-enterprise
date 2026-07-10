import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { brandChannelRef } from "@orderhub/shared";

// Phase BF — variant-menu publish for direct channels. Lets a BRAND'S
// per-channel pricing (a standing setting, brand's Channels tab) come from
// a NAMED PRICING VARIANT defined on a DIFFERENT ("source") menu — e.g. one
// central menu holds every brand's per-channel prices (the "Variant
// menu"), and each brand's Uber Eats/Deliveroo/WhatsApp/Online channel
// points at it once. Mirrors how HubRise already resolves per-brand
// pricing in one shared catalog (a variant already carries its own brandId
// + channelKey) — no separate "pick a variant" step, and it applies to
// EVERY future publish for that channel, not just the one active when it
// was configured. This cross-menu resolution is genuinely new: HubRise's
// existing variant publish (hubrise-catalog.service.ts) only ever reads
// overrides from the SAME menu being published — nothing before this
// resolved a variant from a different menu.
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
   * Standing per-(brand, channel) lookup — mirrors how HubRise already
   * resolves per-brand pricing in a shared catalog: the variant is already
   * tagged with its own brandId + channelKey, so once the brand's
   * "Channels" settings name a source menu, the variant ref is derived
   * automatically (brandChannelRef) — no separate "pick a variant" step,
   * and no re-selection on every future publish. Returns null when this
   * brand+channel has no source menu configured (the caller falls back to
   * normal pricing — this is opt-in, not a replacement for it).
   */
  async forBrandChannel(args: {
    brandId: string;
    channel: string;
  }): Promise<VariantPriceMap | null> {
    const source = await (this.prisma as any).brandChannelSource.findUnique({
      where: { brandId_channel: { brandId: args.brandId, channel: args.channel } },
      select: { sourceMenuId: true },
    });
    if (!source?.sourceMenuId) return null;
    return this.buildPriceMap(source.sourceMenuId, brandChannelRef(args.brandId, args.channel));
  }
}

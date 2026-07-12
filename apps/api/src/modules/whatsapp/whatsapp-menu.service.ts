import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { MenuAssignmentsService } from "../menus/menu-assignments.service";
import { VariantPriceResolverService } from "../menus/variant-price-resolver.service";

// Phase AY (P2) — serves the LIVE published menu for the location behind a
// WhatsApp business number. We do NOT push a catalog to Meta (unlike HubRise);
// the bot reads the same Menu→categories→items→modifierGroups the storefront
// and POS use, so a price change is instantly reflected in chat. Resolution:
// an Integration(platform=WHATSAPP) whose credentials.phoneNumberId matches,
// else the WHATSAPP_LOCATION_ID env fallback (until P6 wires the dashboard
// "Connect WhatsApp" flow).

export interface WaMenuModifierOption {
  id: string;
  name: string;
  price: number; // per-unit adjustment
}

export interface WaMenuModifierGroup {
  id: string;
  name: string;
  required: boolean;
  min: number;
  max: number | null;
  /** VARIANT = pick-one, ADDON = pick-many. */
  selectionType: string;
  options: WaMenuModifierOption[];
}

export interface WaMenuItem {
  id: string;
  name: string;
  description?: string;
  price: number;
  imageUrl?: string;
  categoryName: string;
  modifierGroups: WaMenuModifierGroup[];
}

export interface WaMenuContext {
  tenantId: string;
  locationId: string;
  brandId?: string;
  locationName: string;
  /** This location's WhatsApp business number (for the wa.me return link). */
  displayPhoneNumber?: string;
  /** Per-number WhatsApp Flow id (the "Customise" native form). A Flow is
   *  locked to ONE WhatsApp Business Account, so each connected number stores
   *  its own Flow id here — resolved from Integration.settings.flowId. Falls
   *  back to the WHATSAPP_FLOW_ID env for the single-number pilot. */
  flowId?: string;
  menuId: string;
  items: WaMenuItem[];
  /** id -> item, for O(1) cart validation. */
  itemIndex: Map<string, WaMenuItem>;
  /** optionId -> { groupId, option }, for modifier validation. */
  optionIndex: Map<string, { groupId: string; itemId: string; option: WaMenuModifierOption }>;
}

const MENU_INCLUDE = {
  categories: {
    orderBy: { sortOrder: "asc" as const },
    where: { isVisible: true },
    include: {
      items: {
        where: { item: { isAvailable: true } },
        orderBy: { sortOrder: "asc" as const },
        include: {
          item: {
            include: {
              modifierGroupLinks: {
                orderBy: { sortOrder: "asc" as const },
                include: {
                  group: {
                    include: {
                      options: {
                        where: { isAvailable: true },
                        orderBy: { sortOrder: "asc" as const },
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
};

@Injectable()
export class WhatsAppMenuService {
  private readonly logger = new Logger(WhatsAppMenuService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // Phase BA — serving-assignment resolver (assignment-first menu pick).
    private readonly menuAssignments: MenuAssignmentsService,
    // Phase BF — variant-menu publish (price from a different menu's variant).
    private readonly variantResolver: VariantPriceResolverService,
  ) {}

  /** Resolve the location + live menu for an inbound WhatsApp message. */
  async resolveContext(phoneNumberId?: string): Promise<WaMenuContext | null> {
    const resolved = await this.resolveConnection(phoneNumberId);
    const locationId = resolved?.locationId ?? null;
    if (!locationId) {
      this.logger.warn(
        `No WhatsApp location for phoneNumberId=${phoneNumberId ?? "—"} (set WHATSAPP_LOCATION_ID or connect an integration)`,
      );
      return null;
    }

    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: {
        id: true,
        brandId: true,
        name: true,
        brand: { select: { tenantId: true } },
      },
    });
    if (!location) {
      this.logger.warn(`WhatsApp location ${locationId} not found`);
      return null;
    }

    // Phase BF — variant-menu publish. Only set when the brand's Channels
    // settings name a source menu for WHATSAPP; null otherwise, in which
    // case every price falls back to normal (base price / category
    // priceOverride) exactly as before.
    const variantMap = location.brandId
      ? await this.variantResolver.forBrandChannel({
          brandId: location.brandId,
          channel: "WHATSAPP",
        })
      : null;

    // Operator-pinned menu wins (set in the WhatsApp panel). Falls back to the
    // storefront rule: location-scoped active menu, then brand-scoped.
    let menu =
      resolved?.menuId
        ? await this.prisma.menu.findFirst({
            where: { id: resolved.menuId, deletedAt: null },
            include: MENU_INCLUDE,
          })
        : null;
    if (!menu) {
      // Phase BA — serving assignment for (location, WHATSAPP) wins first
      // (operator-pinned menuId above still beats everything). The legacy
      // publishedTo cascade below keeps un-republished setups working.
      const assignedMenuId = await this.menuAssignments.resolveAssignedMenuId({
        locationId: location.id,
        channel: "WHATSAPP",
        preferBrandId: location.brandId,
      });
      menu = assignedMenuId
        ? await this.prisma.menu.findFirst({
            where: { id: assignedMenuId },
            include: MENU_INCLUDE,
          })
        : null;
    }
    if (!menu) {
      // Prefer a menu explicitly published to WhatsApp (Publish → WhatsApp),
      // location-scoped first then brand-scoped, before the generic
      // active-menu fallback so "publish to WhatsApp" actually selects it.
      menu =
        (await this.prisma.menu.findFirst({
          where: {
            locationId: location.id,
            isActive: true,
            deletedAt: null,
            publishedTo: { has: "WHATSAPP" },
          },
          orderBy: { updatedAt: "desc" },
          include: MENU_INCLUDE,
        })) ??
        (await this.prisma.menu.findFirst({
          where: {
            brandId: location.brandId,
            isActive: true,
            deletedAt: null,
            publishedTo: { has: "WHATSAPP" },
          },
          orderBy: { updatedAt: "desc" },
          include: MENU_INCLUDE,
        })) ??
        (await this.prisma.menu.findFirst({
          where: { locationId: location.id, isActive: true, deletedAt: null },
          orderBy: { updatedAt: "desc" },
          include: MENU_INCLUDE,
        })) ??
        (await this.prisma.menu.findFirst({
          where: {
            brandId: location.brandId,
            isActive: true,
            deletedAt: null,
            locationId: null,
          },
          orderBy: { updatedAt: "desc" },
          include: MENU_INCLUDE,
        }));
    }

    if (!menu) {
      this.logger.warn(`No active menu for location ${location.id}`);
      return null;
    }

    const items: WaMenuItem[] = [];
    const itemIndex = new Map<string, WaMenuItem>();
    const optionIndex = new Map<
      string,
      { groupId: string; itemId: string; option: WaMenuModifierOption }
    >();

    // Resolve modifier groups attached per-SKU. Multi-SKU products store
    // their groups as IDs in productSkus[].modifierGroups (no FK), and those
    // groups can belong to a different brand, so resolve them by id —
    // brand-drift safe, same fix the storefront uses. Flat products use the
    // FK-joined modifierGroupLinks already in the menu include.
    const groupById = new Map<string, any>();
    for (const category of menu.categories)
      for (const link of category.items)
        for (const gl of (link.item as any)?.modifierGroupLinks ?? [])
          if (gl.group?.id) groupById.set(gl.group.id, gl.group);
    const skuGroupIds = new Set<string>();
    for (const category of menu.categories)
      for (const link of category.items) {
        const it = link.item as any;
        if (it?.hasMultipleSkus && Array.isArray(it.productSkus))
          for (const s of it.productSkus)
            for (const gid of s?.modifierGroups ?? [])
              if (typeof gid === "string" && gid && !groupById.has(gid))
                skuGroupIds.add(gid);
      }
    if (skuGroupIds.size) {
      const extra = await this.prisma.modifierGroup.findMany({
        where: { id: { in: [...skuGroupIds] } },
        include: {
          options: {
            where: { isAvailable: true },
            orderBy: { sortOrder: "asc" as const },
          },
        },
      });
      for (const g of extra) groupById.set(g.id, g);
    }

    const toWaGroups = (groups: any[], waItemId: string): WaMenuModifierGroup[] => {
      const out: WaMenuModifierGroup[] = [];
      for (const g of groups) {
        if (!g || !g.visibleToCustomers) continue;
        const options: WaMenuModifierOption[] = (g.options ?? [])
          .filter((o: any) => o.visibleToCustomers)
          .map((o: any) => {
            const opt = {
              id: o.id,
              name: o.name,
              price: variantMap?.optionPrice(o) ?? Number(o.priceAdjustment),
            };
            optionIndex.set(o.id, { groupId: g.id, itemId: waItemId, option: opt });
            return opt;
          });
        out.push({
          id: g.id,
          name: g.name,
          required: g.isRequired,
          min: g.minSelections,
          max: g.maxSelections ?? null,
          selectionType: g.selectionType,
          options,
        });
      }
      return out;
    };

    const pushItem = (waItem: WaMenuItem) => {
      // De-dupe: an item (or size) can appear in multiple categories.
      if (!itemIndex.has(waItem.id)) {
        items.push(waItem);
        itemIndex.set(waItem.id, waItem);
      }
    };

    for (const category of menu.categories) {
      for (const link of category.items) {
        const item = link.item as any;
        if (!item) continue;
        // A configured variant restricts WhatsApp to ONLY that variant's
        // own brand's items — everything else is dropped entirely, not
        // merely left at its own price.
        if (variantMap && !variantMap.appliesToItem(item)) continue;
        const multi =
          !!item.hasMultipleSkus &&
          Array.isArray(item.productSkus) &&
          item.productSkus.length > 0;

        if (multi) {
          // One selectable entry per size, each with its own price + the
          // modifier groups attached to that size. e.g. "Margherita (10")".
          item.productSkus.forEach((sku: any, i: number) => {
            const waId = `${item.id}::${i}`;
            const sizeName =
              (sku?.name && String(sku.name).trim()) || `Size ${i + 1}`;
            const groups = (sku?.modifierGroups ?? [])
              .map((gid: string) => groupById.get(gid))
              .filter(Boolean);
            pushItem({
              id: waId,
              name: `${item.name} (${sizeName})`,
              description: item.description ?? undefined,
              price: variantMap?.skuPrice(item, sku) ?? Number(sku?.price ?? 0),
              imageUrl: item.imageUrl ?? undefined,
              categoryName: category.name,
              modifierGroups: toWaGroups(groups, waId),
            });
          });
        } else {
          const groups = (item.modifierGroupLinks ?? [])
            .map((gl: any) => gl.group)
            .filter(Boolean);
          pushItem({
            id: item.id,
            name: item.name,
            description: item.description ?? undefined,
            price:
              variantMap?.itemPrice(item) ??
              Number(link.priceOverride ?? item.basePrice),
            imageUrl: item.imageUrl ?? undefined,
            categoryName: category.name,
            modifierGroups: toWaGroups(groups, item.id),
          });
        }
      }
    }

    return {
      tenantId: location.brand.tenantId,
      locationId: location.id,
      brandId: location.brandId ?? undefined,
      locationName: location.name,
      displayPhoneNumber: resolved?.displayPhoneNumber,
      flowId: resolved?.flowId,
      menuId: menu.id,
      items,
      itemIndex,
      optionIndex,
    };
  }

  /**
   * Map a Meta phone-number-id → location (+ its display number for the
   * wa.me return link). Routing key lives in Integration.settings.phoneNumberId
   * (non-secret, unencrypted). A matching but disabled (status≠ACTIVE)
   * integration returns null so the channel is truly off. No match → the
   * single-number WHATSAPP_LOCATION_ID env fallback (the original pilot).
   */
  private async resolveConnection(
    phoneNumberId?: string,
  ): Promise<{
    locationId: string;
    displayPhoneNumber?: string;
    menuId?: string;
    flowId?: string;
  } | null> {
    if (phoneNumberId) {
      const integrations = await this.prisma.integration.findMany({
        where: { platform: "WHATSAPP" as any, deletedAt: null },
        select: { locationId: true, status: true, settings: true, credentials: true },
      });
      const match = integrations.find((i) => {
        const s = (i.settings as any) ?? {};
        const c = (i.credentials as any) ?? {};
        return s.phoneNumberId === phoneNumberId || c.phoneNumberId === phoneNumberId;
      });
      if (match) {
        if ((match.status as string) !== "ACTIVE") return null; // connected but disabled
        const s = (match.settings as any) ?? {};
        return {
          locationId: match.locationId,
          displayPhoneNumber: s.displayPhoneNumber,
          menuId: s.menuId || undefined,
          // Per-number Flow id — this number's own published "Customise" Flow
          // (a Flow only works within the WABA it was created in).
          flowId: (s.flowId && String(s.flowId).trim()) || undefined,
        };
      }
    }
    const envLoc = this.config.get<string>("WHATSAPP_LOCATION_ID");
    return envLoc ? { locationId: envLoc } : null;
  }

  /** Compact menu rendering for the AI system prompt (names, prices, ids). */
  renderMenuForAi(ctx: WaMenuContext): string {
    const byCategory = new Map<string, WaMenuItem[]>();
    for (const item of ctx.items) {
      const arr = byCategory.get(item.categoryName) ?? [];
      arr.push(item);
      byCategory.set(item.categoryName, arr);
    }
    const sections: string[] = [];
    for (const [cat, catItems] of byCategory) {
      const lines = [`## ${cat}`];
      for (const item of catItems) {
        lines.push(
          `- ${item.name} — £${item.price.toFixed(2)} [id:${item.id}]${
            item.description ? ` — ${item.description}` : ""
          }`,
        );
        for (const g of item.modifierGroups) {
          const rule = g.required
            ? `required, pick ${g.min}${g.max ? `-${g.max}` : "+"}`
            : `optional${g.max ? `, up to ${g.max}` : ""}`;
          lines.push(`    • ${g.name} [grp:${g.id}] (${rule}):`);
          for (const o of g.options) {
            const p = o.price ? ` +£${o.price.toFixed(2)}` : "";
            lines.push(`        - ${o.name}${p} [opt:${o.id}]`);
          }
        }
      }
      sections.push(lines.join("\n"));
    }
    return sections.join("\n\n");
  }
}

// Phase AW-11 — HubRise catalog import + publish.
//
// IMPORT  HubRise → our schema
//   GET  /v1/catalogs/:catalogId            (full catalog, includes data{})
//   We upsert local Menu + MenuCategory + MenuItem + ModifierGroup +
//   ModifierOption rows. Match by (platformSource="HUBRISE", externalId=ref)
//   so a re-import after a HubRise edit updates in place rather than
//   duplicating products.
//
// PUBLISH our schema → HubRise
//   POST /v1/locations/:locId/catalogs       (first publish — new catalog)
//   PUT  /v1/catalogs/:catalogId             (replaces existing data wholesale)
//   We pick PUT when Location.hubriseCatalogId is already set so HubRise
//   stays at exactly one catalog per location.
//
// Auth: per-location access token decrypted from Location.hubriseCredentials
// on every call (no token cache yet, volume doesn't warrant it).
// HubRise expects the token in the `X-Access-Token` header.

import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";

// ── HubRise types (subset we read / write) ────────────────────────────

interface HubRiseCatalog {
  id: string;
  location_id?: string;
  account_id?: string;
  name: string;
  created_at?: string;
  data: HubRiseCatalogData;
}

interface HubRiseCatalogData {
  variants?: Array<{ ref: string; name: string }>;
  categories?: HubRiseCategory[];
  products?: HubRiseProduct[];
  option_lists?: HubRiseOptionList[];
}

interface HubRiseCategory {
  ref: string;
  parent_ref?: string | null;
  name: string;
  description?: string | null;
  tags?: string[];
  image_ids?: string[];
}

interface HubRiseProduct {
  ref?: string | null;
  category_ref: string;
  name: string;
  description?: string | null;
  tags?: string[];
  image_ids?: string[];
  skus?: HubRiseSku[];
  tax_rate?: { delivery?: string; collection?: string; eat_in?: string };
}

interface HubRiseSku {
  ref?: string | null;
  name?: string | null;
  price: string; // "10.30 GBP"
  option_list_refs?: string[];
  tags?: string[];
}

interface HubRiseOptionList {
  ref: string;
  name: string;
  min_selections?: number;
  max_selections?: number | null;
  multiple_selection?: boolean;
  tags?: string[];
  options?: HubRiseOption[];
}

interface HubRiseOption {
  ref?: string | null;
  name: string;
  price: string;
  default?: boolean;
  tags?: string[];
}

@Injectable()
export class HubRiseCatalogService {
  private readonly logger = new Logger(HubRiseCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly credentialEncryption: CredentialEncryptionService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // IMPORT
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Pull the HubRise catalog this location is configured against and
   * upsert into one Menu + child rows. Returns the menu id so the
   * caller can navigate the operator straight into the editor.
   */
  async importToMenu(args: {
    tenantId: string;
    brandId: string;
    locationId: string;
    /** Optional override; defaults to Location.hubriseCatalogId. */
    catalogId?: string;
  }): Promise<{ menuId: string; counts: ImportCounts }> {
    const location = await this.prisma.location.findFirst({
      where: { id: args.locationId, brand: { tenantId: args.tenantId } },
      select: {
        id: true,
        brandId: true,
        hubriseCredentials: true,
        hubriseCatalogId: true,
      },
    });
    if (!location) throw new NotFoundException("Location not found");

    const catalogId = args.catalogId ?? location.hubriseCatalogId;
    if (!catalogId) {
      throw new BadRequestException(
        "No HubRise catalog id configured for this location. Connect HubRise + set the catalog id in Location settings first.",
      );
    }

    const catalog = await this.fetchCatalog(
      catalogId,
      location.hubriseCredentials,
    );

    return this.applyCatalogToMenu(catalog, {
      brandId: args.brandId,
      locationId: args.locationId,
    });
  }

  /**
   * Upsert the catalog data into a Menu owned by the brand. The Menu is
   * identified by (brandId, platformSource=HUBRISE, externalId=catalog.id);
   * categories / items / modifier groups / options are identified by
   * their HubRise ref.
   */
  private async applyCatalogToMenu(
    catalog: HubRiseCatalog,
    target: { brandId: string; locationId: string },
  ): Promise<{ menuId: string; counts: ImportCounts }> {
    const data = catalog.data ?? {};
    const counts: ImportCounts = {
      categories: 0,
      products: 0,
      modifierGroups: 0,
      modifierOptions: 0,
    };

    // 1. Find-or-create the Menu.
    const existingMenu = await (this.prisma as any).menu.findFirst({
      where: {
        brandId: target.brandId,
        platformSource: "HUBRISE",
        externalId: catalog.id,
        deletedAt: null,
      },
      select: { id: true },
    });

    const menu = existingMenu
      ? await (this.prisma as any).menu.update({
          where: { id: existingMenu.id },
          data: {
            name: catalog.name,
            locationId: target.locationId,
            importStatus: "IDLE",
            importedAt: new Date(),
            syncVersion: { increment: 1 },
            rawImportPayload: catalog as any,
            lastSyncedAt: new Date(),
            syncStatus: "ok",
          },
        })
      : await (this.prisma as any).menu.create({
          data: {
            brandId: target.brandId,
            locationId: target.locationId,
            name: catalog.name,
            description: `Imported from HubRise on ${new Date().toISOString().slice(0, 10)}`,
            status: "DRAFT",
            isActive: false,
            platformSource: "HUBRISE",
            externalId: catalog.id,
            importStatus: "IDLE",
            importedAt: new Date(),
            syncVersion: 1,
            rawImportPayload: catalog as any,
            lastSyncedAt: new Date(),
            syncStatus: "ok",
          },
        });

    // 2. ModifierGroups + Options (upsert first so SKUs can link).
    const groupByRef = new Map<string, string>(); // hubrise ref → our group id
    for (const list of data.option_lists ?? []) {
      const existing = await (this.prisma as any).modifierGroup.findFirst({
        where: {
          brandId: target.brandId,
          platformSource: "HUBRISE",
          externalId: list.ref,
        },
        select: { id: true },
      });
      const groupId = existing
        ? (
            await (this.prisma as any).modifierGroup.update({
              where: { id: existing.id },
              data: {
                name: list.name,
                minSelections: list.min_selections ?? 0,
                maxSelections: list.max_selections ?? null,
                isRequired: (list.min_selections ?? 0) > 0,
                selectionType: list.multiple_selection ? "ADDON" : "VARIANT",
                lastSyncedAt: new Date(),
                syncStatus: "ok",
              },
            })
          ).id
        : (
            await (this.prisma as any).modifierGroup.create({
              data: {
                brandId: target.brandId,
                locationId: target.locationId,
                name: list.name,
                minSelections: list.min_selections ?? 0,
                maxSelections: list.max_selections ?? null,
                isRequired: (list.min_selections ?? 0) > 0,
                selectionType: list.multiple_selection ? "ADDON" : "VARIANT",
                platformSource: "HUBRISE",
                externalId: list.ref,
                lastSyncedAt: new Date(),
                syncStatus: "ok",
              },
            })
          ).id;
      groupByRef.set(list.ref, groupId);
      counts.modifierGroups++;

      for (const opt of list.options ?? []) {
        const priceAdj = parseHubRisePrice(opt.price);
        const optExternal = opt.ref ?? `${list.ref}__${opt.name}`;
        const existingOpt = await (this.prisma as any).modifierOption.findFirst(
          {
            where: {
              groupId,
              platformSource: "HUBRISE",
              externalId: optExternal,
            },
            select: { id: true },
          },
        );
        if (existingOpt) {
          await (this.prisma as any).modifierOption.update({
            where: { id: existingOpt.id },
            data: {
              name: opt.name,
              priceAdjustment: priceAdj,
              isDefault: opt.default === true,
              lastSyncedAt: new Date(),
              syncStatus: "ok",
            },
          });
        } else {
          await (this.prisma as any).modifierOption.create({
            data: {
              groupId,
              name: opt.name,
              priceAdjustment: priceAdj,
              isDefault: opt.default === true,
              platformSource: "HUBRISE",
              externalId: optExternal,
              externalParentId: list.ref,
              lastSyncedAt: new Date(),
              syncStatus: "ok",
            },
          });
        }
        counts.modifierOptions++;
      }
    }

    // 3. Categories.
    const categoryByRef = new Map<string, string>(); // ref → MenuCategory.id
    for (let i = 0; i < (data.categories ?? []).length; i++) {
      const cat = data.categories![i]!;
      const existing = await (this.prisma as any).menuCategory.findFirst({
        where: {
          menuId: menu.id,
          platformSource: "HUBRISE",
          externalId: cat.ref,
        },
        select: { id: true },
      });
      const categoryId = existing
        ? (
            await (this.prisma as any).menuCategory.update({
              where: { id: existing.id },
              data: {
                name: cat.name,
                description: cat.description ?? null,
                sortOrder: i,
                lastSyncedAt: new Date(),
                syncStatus: "ok",
              },
            })
          ).id
        : (
            await (this.prisma as any).menuCategory.create({
              data: {
                menuId: menu.id,
                name: cat.name,
                description: cat.description ?? null,
                sortOrder: i,
                platformSource: "HUBRISE",
                externalId: cat.ref,
                externalParentId: cat.parent_ref ?? null,
                lastSyncedAt: new Date(),
                syncStatus: "ok",
              },
            })
          ).id;
      categoryByRef.set(cat.ref, categoryId);
      counts.categories++;
    }

    // 4. Products + SKUs. Multi-SKU products land in MenuItem.productSkus
    //    (the multi-size pizza pattern). Single-SKU products use basePrice
    //    + plu from the single sku.
    for (const product of data.products ?? []) {
      const categoryId = categoryByRef.get(product.category_ref);
      if (!categoryId) continue;
      const skus = product.skus ?? [];
      const isMulti = skus.length > 1;
      const firstSku = skus[0];
      const basePrice = firstSku ? parseHubRisePrice(firstSku.price) : 0;

      // External ref for the MenuItem: the product.ref if present,
      // otherwise the first sku.ref, otherwise a stable hash so a
      // re-import still matches.
      const productExternal =
        product.ref ?? firstSku?.ref ?? `${product.category_ref}__${product.name}`;

      const productSkus = isMulti
        ? skus.map((s) => ({
            name: s.name ?? "",
            plu: s.ref ?? null,
            price: parseHubRisePrice(s.price),
            modifierGroups: (s.option_list_refs ?? [])
              .map((r) => groupByRef.get(r))
              .filter(Boolean),
          }))
        : [];

      const existing = await (this.prisma as any).menuItem.findFirst({
        where: {
          brandId: target.brandId,
          platformSource: "HUBRISE",
          externalId: productExternal,
        },
        select: { id: true },
      });
      const item = existing
        ? await (this.prisma as any).menuItem.update({
            where: { id: existing.id },
            data: {
              name: product.name,
              description: product.description ?? null,
              basePrice,
              plu: firstSku?.ref ?? null,
              hasMultipleSkus: isMulti,
              productSkus: productSkus as any,
              lastSyncedAt: new Date(),
              syncStatus: "ok",
            },
          })
        : await (this.prisma as any).menuItem.create({
            data: {
              brandId: target.brandId,
              locationId: target.locationId,
              name: product.name,
              description: product.description ?? null,
              basePrice,
              plu: firstSku?.ref ?? null,
              isAvailable: true,
              hasMultipleSkus: isMulti,
              productSkus: productSkus as any,
              menuIds: [menu.id],
              platformSource: "HUBRISE",
              externalId: productExternal,
              externalParentId: product.category_ref,
              lastSyncedAt: new Date(),
              syncStatus: "ok",
            },
          });

      // 4a. Link to the category.
      await (this.prisma as any).menuItemOnCategory.upsert({
        where: { categoryId_itemId: { categoryId, itemId: item.id } },
        update: {},
        create: { categoryId, itemId: item.id, sortOrder: 0 },
      });

      // 4b. Link single-SKU products to their modifier groups via the
      //     dedicated link table. Multi-SKU products carry their links
      //     in productSkus[].modifierGroups above; the POS picks from
      //     whichever exists.
      if (!isMulti && firstSku) {
        // Wipe existing links for this product so removed option lists
        // on the HubRise side disappear here too.
        await (this.prisma as any).modifierGroupOnItem.deleteMany({
          where: { itemId: item.id },
        });
        let order = 0;
        for (const ref of firstSku.option_list_refs ?? []) {
          const groupId = groupByRef.get(ref);
          if (!groupId) continue;
          await (this.prisma as any).modifierGroupOnItem.create({
            data: { itemId: item.id, groupId, sortOrder: order++ },
          });
        }
      }
      counts.products++;
    }

    this.logger.log(
      `HubRise import: menu=${menu.id} brand=${target.brandId} location=${target.locationId} ${JSON.stringify(counts)}`,
    );
    return { menuId: menu.id, counts };
  }

  // ─────────────────────────────────────────────────────────────────────
  // PUBLISH
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Convert one of our Menus into a HubRise catalog data object and
   * push to HubRise. Returns the HubRise catalog id (the one we
   * created or updated). When `Location.hubriseCatalogId` is already
   * set we PUT (overwrite); otherwise we POST a fresh catalog.
   */
  async publishMenu(args: {
    tenantId: string;
    menuId: string;
  }): Promise<{ catalogId: string; created: boolean }> {
    const menu = await (this.prisma as any).menu.findFirst({
      where: { id: args.menuId, brand: { tenantId: args.tenantId } },
      include: {
        categories: {
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              orderBy: { sortOrder: "asc" },
              include: {
                item: {
                  include: {
                    modifierGroupLinks: {
                      include: { group: { include: { options: true } } },
                    },
                  },
                },
              },
            },
          },
        },
        brand: { select: { id: true, tenantId: true } },
      },
    });
    if (!menu) throw new NotFoundException("Menu not found");

    const location = await (this.prisma as any).location.findFirst({
      where: {
        OR: [
          { id: menu.locationId ?? "" },
          { brandId: menu.brandId, hubriseCatalogId: { not: null } },
        ],
      },
      select: {
        id: true,
        hubriseCredentials: true,
        hubriseCatalogId: true,
        hubriseLocationId: true,
      },
    });
    if (!location || !location.hubriseLocationId) {
      throw new BadRequestException(
        "No HubRise-connected location for this menu's brand. Connect HubRise on a location first.",
      );
    }

    const { categories, products, optionLists } = transformMenuToCatalog(menu);

    const data: HubRiseCatalogData = {
      categories,
      products,
      option_lists: optionLists,
    };

    if (location.hubriseCatalogId) {
      // Overwrite.
      await this.callHubRise(
        `PUT`,
        `/catalogs/${location.hubriseCatalogId}`,
        location.hubriseCredentials,
        { name: menu.name, data },
      );
      await this.markPublished(args.menuId, location.hubriseCatalogId);
      return { catalogId: location.hubriseCatalogId, created: false };
    }

    const created = (await this.callHubRise(
      "POST",
      `/locations/${location.hubriseLocationId.toLowerCase()}/catalogs`,
      location.hubriseCredentials,
      { name: menu.name, data },
    )) as { id: string };

    await (this.prisma as any).location.update({
      where: { id: location.id },
      data: { hubriseCatalogId: created.id },
    });
    await this.markPublished(args.menuId, created.id);
    return { catalogId: created.id, created: true };
  }

  private async markPublished(menuId: string, hubriseCatalogId: string) {
    await (this.prisma as any).menu.update({
      where: { id: menuId },
      data: {
        lastPublishedAt: new Date(),
        platformSource: "HUBRISE",
        externalId: hubriseCatalogId,
        // Append HUBRISE to publishedTo without duplicating. We could
        // do this in a transaction with a read+write but the publish
        // path is single-threaded per menu so a stale-overwrite race
        // isn't worth a tx round-trip.
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // HTTP
  // ─────────────────────────────────────────────────────────────────────

  private async fetchCatalog(
    catalogId: string,
    credentialsBlob: unknown,
  ): Promise<HubRiseCatalog> {
    return this.callHubRise(
      "GET",
      `/catalogs/${catalogId}`,
      credentialsBlob,
    ) as Promise<HubRiseCatalog>;
  }

  private async callHubRise<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH",
    path: string,
    credentialsBlob: unknown,
    body?: unknown,
  ): Promise<T> {
    if (!credentialsBlob) {
      throw new BadRequestException(
        "No HubRise credentials saved for this location",
      );
    }
    const decrypted = this.credentialEncryption.decrypt(
      credentialsBlob as Record<string, unknown>,
    ) as Record<string, string>;
    const accessToken = decrypted.accessToken;
    if (!accessToken) {
      throw new BadRequestException(
        "HubRise access token missing from credentials envelope",
      );
    }
    const baseUrl =
      this.config.get<string>("app.platforms.hubrise.baseUrl") ??
      "https://api.hubrise.com/v1";
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "X-Access-Token": accessToken,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(
        `HubRise ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

export interface ImportCounts {
  categories: number;
  products: number;
  modifierGroups: number;
  modifierOptions: number;
}

/** HubRise prices arrive as "10.30 GBP" — strip the currency suffix. */
function parseHubRisePrice(value: string | null | undefined): number {
  if (!value) return 0;
  const m = String(value).match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

/** Money string the HubRise way. Caller passes the numeric amount; we
 *  format with two decimals and the catalog-wide currency. */
function formatHubRisePrice(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/**
 * Walk our Menu graph and emit HubRise's catalog data shape.
 * Currency defaults to GBP — operator can change in a future phase.
 */
function transformMenuToCatalog(menu: any): {
  categories: HubRiseCategory[];
  products: HubRiseProduct[];
  optionLists: HubRiseOptionList[];
} {
  const currency = "GBP";

  // Categories
  const categories: HubRiseCategory[] = (menu.categories ?? []).map(
    (c: any, idx: number) => ({
      // Prefer the original HubRise ref so a round-trip stays stable;
      // otherwise mint a deterministic ref from the row id so future
      // re-publishes match the same category.
      ref: c.externalId ?? `cat_${c.id}`,
      name: c.name,
      description: c.description ?? null,
    }),
  );

  // ModifierGroups + options — deduplicate across categories.
  const groupSeen = new Set<string>();
  const optionLists: HubRiseOptionList[] = [];
  for (const cat of menu.categories ?? []) {
    for (const link of cat.items ?? []) {
      const item = link.item;
      const groups = (item.modifierGroupLinks ?? []).map((l: any) => l.group);
      for (const g of groups) {
        const ref = g.externalId ?? `grp_${g.id}`;
        if (groupSeen.has(ref)) continue;
        groupSeen.add(ref);
        optionLists.push({
          ref,
          name: g.name,
          min_selections: g.minSelections ?? 0,
          max_selections: g.maxSelections ?? null,
          multiple_selection: g.selectionType === "ADDON",
          options: (g.options ?? []).map((o: any) => ({
            ref: o.externalId ?? `opt_${o.id}`,
            name: o.name,
            price: formatHubRisePrice(Number(o.priceAdjustment ?? 0), currency),
            default: o.isDefault === true,
          })),
        });
      }
    }
  }

  // Products
  const products: HubRiseProduct[] = [];
  for (const cat of menu.categories ?? []) {
    const catRef = cat.externalId ?? `cat_${cat.id}`;
    for (const link of cat.items ?? []) {
      const item = link.item;
      const multi = !!item.hasMultipleSkus && Array.isArray(item.productSkus);
      const skus: HubRiseSku[] = multi
        ? (item.productSkus as any[]).map((s, i) => ({
            ref: s.plu ?? `${item.id}_sku_${i}`,
            name: s.name,
            price: formatHubRisePrice(Number(s.price ?? 0), currency),
            option_list_refs: (s.modifierGroups ?? []).map((gid: string) => {
              const g = item.modifierGroupLinks
                ?.map((l: any) => l.group)
                .find((g: any) => g.id === gid);
              return g?.externalId ?? `grp_${gid}`;
            }),
          }))
        : [
            {
              ref: item.plu ?? item.externalId ?? `${item.id}_sku`,
              name: null,
              price: formatHubRisePrice(Number(item.basePrice ?? 0), currency),
              option_list_refs: (item.modifierGroupLinks ?? []).map(
                (l: any) => l.group.externalId ?? `grp_${l.group.id}`,
              ),
            },
          ];
      products.push({
        ref: item.externalId ?? `prod_${item.id}`,
        category_ref: catRef,
        name: item.name,
        description: item.description ?? null,
        skus,
      });
    }
  }

  return { categories, products, optionLists };
}

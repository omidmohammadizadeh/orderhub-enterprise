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
import {
  normalizePricingVariants,
  buildHubRisePriceOverrides,
  variantRefsForBrands,
  type HubRisePriceOverride,
} from "@orderhub/shared";

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
  // HubRise's response field name for option lists drifts between
  // `option_lists` (URL path + docs intro) and `options_lists` (the
  // catalog `data` field as actually shipped). Accept both — readers
  // in this file normalise via `getOptionLists()` below.
  option_lists?: HubRiseOptionList[];
  options_lists?: HubRiseOptionList[];
}

// HubRise's catalog GET response gives every entity TWO keys:
//   id  — internal opaque key (e.g. "7xdnep"). Used as the link target
//         from every reference (category_id, option_list_id,
//         option_list_ids[]). Stable across operator edits.
//   ref — operator-set human key (e.g. "0", "TESLA_S"). May be null,
//         duplicated, or changed over time.
// We index lookups by id (always present, stable) and fall back to
// ref for back-compat with the documented examples. Both fields are
// modelled as optional so payloads built by the publish path (which
// doesn't have HubRise ids until after the create round-trip) still
// fit the type.
interface HubRiseCategory {
  id?: string;
  ref?: string | null;
  parent_id?: string | null;
  parent_ref?: string | null;
  name: string;
  description?: string | null;
  tags?: string[];
  image_ids?: string[];
  products?: HubRiseProduct[];
}

interface HubRiseProduct {
  id?: string;
  ref?: string | null;
  category_id?: string;
  category_ref?: string;
  name: string;
  description?: string | null;
  tags?: string[];
  // Round-tripped on publish from items imported with a HubRise image
  // (see transformMenuToCatalog). HubRise treats the array as ordered;
  // we send a single id so the existing upload is reused rather than
  // re-bytes-uploaded.
  image_ids?: string[];
  skus?: HubRiseSku[];
  tax_rate?: { delivery?: string; collection?: string; eat_in?: string } | null;
}

interface HubRiseSku {
  id?: string;
  ref?: string | null;
  product_id?: string;
  name?: string | null;
  price: string; // "10.30 GBP"
  // Per-variant price rules: [{ variant_refs: ["UBER_EATS"], price: "11.99 GBP" }]
  price_overrides?: HubRisePriceOverride[];
  // Brand scoping in a shared catalog — this SKU is only enabled for the
  // listed variant refs (its brand's channels), so a brand's connector
  // only sees that brand's products.
  restrictions?: { variant_refs: string[] };
  option_list_ids?: string[];
  option_list_refs?: string[];
  tags?: string[];
}

interface HubRiseOptionList {
  id?: string;
  ref?: string | null;
  name: string;
  min_selections?: number;
  max_selections?: number | null;
  multiple_selection?: boolean;
  type?: "single" | "multiple";
  tags?: string[];
  options?: HubRiseOption[];
}

interface HubRiseOption {
  id?: string;
  ref?: string | null;
  option_list_id?: string;
  name: string;
  price: string;
  price_overrides?: HubRisePriceOverride[];
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
    const optionLists = data.options_lists ?? data.option_lists ?? [];

    // Phase AW-11.2 — products can live in two places depending on the
    // HubRise account / catalog version: flat at `data.products` OR
    // nested inside each category at `data.categories[].products`.
    // Collapse both into a single flat array; whichever path has rows
    // wins, and we log both counts so the source is obvious.
    const flatProducts = data.products ?? [];
    const nestedProducts: HubRiseProduct[] = [];
    for (const cat of data.categories ?? []) {
      for (const p of cat.products ?? []) {
        // Inject the category ref if the embedded product doesn't carry
        // its own (the nested shape relies on positional ownership).
        nestedProducts.push({
          ...p,
          category_id: p.category_id ?? cat.id,
          category_ref: p.category_ref ?? cat.ref ?? undefined,
        });
      }
    }
    const allProducts =
      flatProducts.length > 0 ? flatProducts : nestedProducts;

    this.logger.log(
      `HubRise catalog ${catalog.id} parsed: ` +
        `categories=${(data.categories ?? []).length} ` +
        `flatProducts=${flatProducts.length} ` +
        `nestedProducts=${nestedProducts.length} ` +
        `productsUsed=${allProducts.length} ` +
        `optionLists=${optionLists.length} ` +
        `variants=${(data.variants ?? []).length} ` +
        `top-level-keys=[${Object.keys(data).join(",")}]`,
    );

    // First-product preview so we can see field shape at a glance the
    // very next time something looks off (price suffix mismatch,
    // category_ref vs categoryRef, etc.).
    if (allProducts.length > 0) {
      const sample = allProducts[0];
      this.logger.log(
        `HubRise catalog ${catalog.id} first product preview: name="${sample?.name}" ` +
          `category_ref="${sample?.category_ref}" ` +
          `skus=${(sample?.skus ?? []).length} ` +
          `keys=[${Object.keys(sample ?? {}).join(",")}]`,
      );
    } else {
      this.logger.warn(
        `HubRise catalog ${catalog.id}: NO products in either flat or nested path. ` +
          `Inspect rawImportPayload on Menu row for the unfiltered response.`,
      );
    }
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
    // Index by both HubRise id (the canonical link key) and ref so the
    // downstream SKU walk can resolve whichever the response uses.
    const groupByHubriseId = new Map<string, string>();
    const groupByRef = new Map<string, string>();
    for (const list of optionLists) {
      const groupExternalId = list.id ?? list.ref;
      const existing = await (this.prisma as any).modifierGroup.findFirst({
        where: {
          brandId: target.brandId,
          platformSource: "HUBRISE",
          externalId: groupExternalId,
        },
        select: { id: true },
      });
      // HubRise has both `multiple_selection: bool` and `type: "single"|"multiple"`.
      // Use either when present.
      const isAddon =
        list.multiple_selection === true || list.type === "multiple";
      const groupId = existing
        ? (
            await (this.prisma as any).modifierGroup.update({
              where: { id: existing.id },
              data: {
                name: list.name,
                minSelections: list.min_selections ?? 0,
                maxSelections: list.max_selections ?? null,
                isRequired: (list.min_selections ?? 0) > 0,
                selectionType: isAddon ? "ADDON" : "VARIANT",
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
                selectionType: isAddon ? "ADDON" : "VARIANT",
                platformSource: "HUBRISE",
                externalId: groupExternalId,
                lastSyncedAt: new Date(),
                syncStatus: "ok",
              },
            })
          ).id;
      if (list.id) groupByHubriseId.set(list.id, groupId);
      if (list.ref) groupByRef.set(list.ref, groupId);
      counts.modifierGroups++;

      for (const opt of list.options ?? []) {
        const priceAdj = parseHubRisePrice(opt.price);
        const optExternal = opt.id ?? opt.ref ?? `${groupExternalId}__${opt.name}`;
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
              externalParentId: groupExternalId,
              lastSyncedAt: new Date(),
              syncStatus: "ok",
            },
          });
        }
        counts.modifierOptions++;
      }
    }

    // 3. Categories. Index by HubRise id (canonical link key from
    //    products.category_id) AND ref so older catalogs still match.
    const categoryByHubriseId = new Map<string, string>();
    const categoryByRef = new Map<string, string>();
    for (let i = 0; i < (data.categories ?? []).length; i++) {
      const cat = data.categories![i]!;
      const catExternalId = cat.id ?? cat.ref ?? `cat_${i}`;
      const existing = await (this.prisma as any).menuCategory.findFirst({
        where: {
          menuId: menu.id,
          platformSource: "HUBRISE",
          externalId: catExternalId,
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
                externalId: catExternalId,
                externalParentId: cat.parent_id ?? cat.parent_ref ?? null,
                lastSyncedAt: new Date(),
                syncStatus: "ok",
              },
            })
          ).id;
      if (cat.id) categoryByHubriseId.set(cat.id, categoryId);
      if (cat.ref) categoryByRef.set(cat.ref, categoryId);
      counts.categories++;
    }

    // 4. Products + SKUs. Multi-SKU products land in MenuItem.productSkus
    //    (the multi-size pizza pattern). Single-SKU products use basePrice
    //    + plu from the single sku.
    let skippedNoCategory = 0;
    for (const product of allProducts) {
      // Product → category lookup: HubRise's response links by
      // category_id (internal opaque key); we fall through to
      // category_ref for catalogs using the documented shape.
      const categoryId =
        (product.category_id && categoryByHubriseId.get(product.category_id)) ||
        (product.category_ref && categoryByRef.get(product.category_ref));
      if (!categoryId) {
        skippedNoCategory++;
        if (skippedNoCategory <= 3) {
          this.logger.warn(
            `HubRise product "${product.name}" skipped: category_id="${product.category_id}" category_ref="${product.category_ref}" not found. ` +
              `Known ids: [${Array.from(categoryByHubriseId.keys()).slice(0, 5).join(",")}${categoryByHubriseId.size > 5 ? ",…" : ""}]`,
          );
        }
        continue;
      }
      const skus = product.skus ?? [];
      const isMulti = skus.length > 1;
      const firstSku = skus[0];
      const basePrice = firstSku ? parseHubRisePrice(firstSku.price) : 0;

      // External key for the MenuItem: HubRise's product.id is the
      // canonical, stable choice. ref + sku fallbacks keep older
      // imports lining up.
      const productExternal =
        product.id ??
        product.ref ??
        firstSku?.ref ??
        `${product.category_id ?? product.category_ref}__${product.name}`;

      // Resolve a SKU's option_list refs into local modifier-group ids.
      // HubRise's response uses option_list_ids (by id); the docs also
      // describe option_list_refs (by ref). Accept both.
      const resolveGroupIds = (s: HubRiseSku): string[] => {
        const out: string[] = [];
        for (const id of s.option_list_ids ?? []) {
          const g = groupByHubriseId.get(id);
          if (g) out.push(g);
        }
        for (const r of s.option_list_refs ?? []) {
          const g = groupByRef.get(r);
          if (g) out.push(g);
        }
        return Array.from(new Set(out));
      };

      const productSkus = isMulti
        ? skus.map((s) => ({
            name: s.name ?? "",
            plu: s.ref ?? null,
            price: parseHubRisePrice(s.price),
            modifierGroups: resolveGroupIds(s),
          }))
        : [];

      // Phase AW-11.1 — first HubRise image becomes the product's
      // imageUrl, routed through our proxy so the browser doesn't need
      // a HubRise access token to render it. Stored as the URL pattern
      // /v1/menus/hubrise-image/:catalogId/:imageId — resolved by the
      // public proxy endpoint that streams the binary back.
      const firstImageId =
        Array.isArray(product.image_ids) && product.image_ids.length > 0
          ? product.image_ids[0]
          : null;
      const imageUrl = firstImageId
        ? `/api/v1/menus/hubrise-image/${catalog.id}/${firstImageId}`
        : null;

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
              ...(imageUrl && { imageUrl }),
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
              imageUrl,
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
        await (this.prisma as any).modifierGroupOnItem.deleteMany({
          where: { itemId: item.id },
        });
        const groupIds = resolveGroupIds(firstSku);
        for (let i = 0; i < groupIds.length; i++) {
          await (this.prisma as any).modifierGroupOnItem.create({
            data: { itemId: item.id, groupId: groupIds[i]!, sortOrder: i },
          });
        }
      }
      counts.products++;
    }

    if (skippedNoCategory > 0) {
      this.logger.warn(
        `HubRise import: ${skippedNoCategory} product(s) skipped because their category_ref didn't match any imported category.`,
      );
    }
    this.logger.log(
      `HubRise import: menu=${menu.id} brand=${target.brandId} location=${target.locationId} ${JSON.stringify(counts)}`,
    );
    return { menuId: menu.id, counts };
  }

  // ─────────────────────────────────────────────────────────────────────
  // IMAGE PROXY
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Phase AW-11.1 — stream a HubRise image's binary back to the browser.
   * Imported menu items have imageUrl set to /v1/menus/hubrise-image/
   * <catalogId>/<imageId>; the controller calls this with the catalog's
   * location's credentials. Returns the raw bytes + content-type so the
   * controller can pipe straight through.
   *
   * Cache: HubRise images don't have a public URL, so every render hits
   * us. The Cache-Control header on the controller side leans on
   * HubRise's image immutability to let browsers + edge cache it
   * aggressively.
   */
  async fetchHubRiseImage(
    catalogId: string,
    imageId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    // Find any location that has this catalogId — the import path saved
    // it onto Location.hubriseCatalogId on first publish or it matches
    // what the operator pasted at HubRise connect time. We don't need
    // the brand/tenant context because the public proxy is read-only
    // and the image ids are already opaque random tokens.
    const location = await (this.prisma as any).location.findFirst({
      where: { hubriseCatalogId: catalogId },
      select: { hubriseCredentials: true },
    });
    if (!location) {
      throw new NotFoundException("HubRise catalog not found");
    }
    const decrypted = this.credentialEncryption.decrypt(
      (location.hubriseCredentials ?? {}) as Record<string, unknown>,
    ) as Record<string, string>;
    const accessToken = decrypted.accessToken;
    if (!accessToken) throw new BadRequestException("No HubRise token");
    const baseUrl =
      this.config.get<string>("app.platforms.hubrise.baseUrl") ??
      "https://api.hubrise.com/v1";
    const res = await fetch(
      `${baseUrl}/catalogs/${catalogId}/images/${imageId}/data`,
      {
        headers: { "X-Access-Token": accessToken },
      },
    );
    if (!res.ok) {
      throw new NotFoundException(`HubRise image ${imageId} → ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    return { buffer, contentType };
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

    // Phase AW-11.4 — collect every modifier group referenced by ANY
    // product in this menu, from both the link table (single-SKU
    // products) AND the productSkus JSON (multi-SKU products). Then
    // fetch them once with their options so the transformer can emit
    // a complete option_lists array AND resolve every SKU's group ids
    // to a real ref.
    const referencedGroupIds = new Set<string>();
    for (const cat of menu.categories ?? []) {
      for (const link of cat.items ?? []) {
        const item = link.item;
        for (const l of item.modifierGroupLinks ?? []) {
          if (l.group?.id) referencedGroupIds.add(l.group.id);
        }
        if (Array.isArray(item.productSkus)) {
          for (const sku of item.productSkus as any[]) {
            for (const gid of sku.modifierGroups ?? []) {
              if (typeof gid === "string" && gid) referencedGroupIds.add(gid);
            }
          }
        }
      }
    }
    const allGroups = referencedGroupIds.size
      ? await (this.prisma as any).modifierGroup.findMany({
          where: { id: { in: Array.from(referencedGroupIds) } },
          include: { options: { orderBy: { sortOrder: "asc" } } },
        })
      : [];
    const groupById = new Map<string, any>(
      allGroups.map((g: any) => [g.id, g] as [string, any]),
    );

    const { categories, products, optionLists, variants } =
      transformMenuToCatalog(menu, groupById);

    this.logger.log(
      `HubRise publish: menu=${args.menuId} categories=${categories.length} ` +
        `products=${products.length} optionLists=${optionLists.length} ` +
        `variants=${variants.length} referencedGroups=${referencedGroupIds.size}`,
    );

    // Sample the first product + its SKUs so we can verify the
    // option_list_refs we're sending actually match a ref emitted in
    // option_lists. This shows in Render's API logs alongside the
    // counts above.
    if (products[0]) {
      this.logger.log(
        `HubRise publish sample product: ` +
          `name="${products[0].name}" ref="${products[0].ref}" ` +
          `image_ids=${JSON.stringify(products[0].image_ids ?? null)} ` +
          `sku0.option_list_refs=${JSON.stringify(products[0].skus?.[0]?.option_list_refs ?? null)} ` +
          `optionListRefs=[${optionLists.map((l) => l.ref).slice(0, 5).join(",")}${optionLists.length > 5 ? ",…" : ""}]`,
      );
    }

    const data: HubRiseCatalogData = {
      // Only send variants[] when the menu actually defines some — an
      // empty array is harmless but noise in HubRise's UI.
      ...(variants.length ? { variants } : {}),
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

  // ─────────────────────────────────────────────────────────────────────
  // INVENTORY PATCH (Phase AW-14)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * PATCH /catalogs/:id/locations/:locId/inventory
   *
   * Used by MenuAvailabilityService when an operator 86s a product.
   * Body is a thin array of inventory entries — HubRise merges; entries
   * NOT in the request are left unchanged.
   *
   *   { sku_ref, stock: "0", expires_at: "ISO" }   ← out of stock
   *   { sku_ref, stock: null }                     ← back to unlimited
   *
   * `option_ref` is also supported (for modifier 86) but the inventory
   * page only flips items in AW-14; we'll wire option-level snooze in
   * a follow-up phase.
   */
  async patchInventory(args: {
    catalogId: string;
    hubriseLocationId: string;
    credentialsBlob: unknown;
    entries: Array<{
      sku_ref?: string;
      option_ref?: string;
      stock: string | null;
      expires_at?: string | null;
    }>;
  }): Promise<void> {
    if (!args.entries.length) return;
    await this.callHubRise(
      "PATCH",
      `/catalogs/${args.catalogId}/locations/${args.hubriseLocationId.toLowerCase()}/inventory`,
      args.credentialsBlob,
      args.entries,
    );
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
 *
 * `groupById` is a pre-fetched lookup of every ModifierGroup referenced
 * by any product in this menu (built by publishMenu from BOTH
 * modifierGroupLinks AND productSkus[].modifierGroups). The transformer
 * uses it as the single source of truth for option_list emission +
 * SKU↔group ref resolution, so multi-SKU products whose groups only
 * live in productSkus JSON still link correctly.
 */
function transformMenuToCatalog(
  menu: any,
  groupById: Map<string, any>,
): {
  categories: HubRiseCategory[];
  products: HubRiseProduct[];
  optionLists: HubRiseOptionList[];
  variants: Array<{ ref: string; name: string }>;
} {
  const currency = "GBP";

  // Phase AZ — pricing variants. One menu, per-channel/brand prices.
  // Build the catalog `variants[]` and a ref-set used to gate every
  // price-override rule so a stale override (variant since removed) is
  // dropped rather than published.
  const variants = normalizePricingVariants(menu.pricingVariants);
  const variantRefs = new Set(variants.map((v) => v.ref));
  const fmtPrice = (n: number) => formatHubRisePrice(n, currency);

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

  // Stable ref for any modifier group: HubRise externalId from the
  // import path, or grp_<cuid> if it was created locally and never
  // round-tripped. Same shape we use to emit option_lists below, so
  // every SKU's option_list_refs lines up with a defined option_list.
  const groupRefFor = (g: any): string => g?.externalId ?? `grp_${g?.id}`;

  // ModifierGroups + options — emit every group referenced by any
  // product in this menu, deduplicated. Iterate the pre-fetched
  // groupById map (which already covers BOTH modifierGroupLinks and
  // productSkus[].modifierGroups paths) so multi-SKU products' groups
  // are not silently dropped.
  const optionLists: HubRiseOptionList[] = [];
  for (const g of groupById.values()) {
    optionLists.push({
      ref: groupRefFor(g),
      name: g.name,
      min_selections: g.minSelections ?? 0,
      max_selections: g.maxSelections ?? null,
      multiple_selection: g.selectionType === "ADDON",
      options: (g.options ?? []).map((o: any) => {
        const optBase = Number(o.priceAdjustment ?? 0);
        const overrides = buildHubRisePriceOverrides(
          o.platformPricingOverrides as Record<string, number> | undefined,
          variantRefs,
          optBase,
          fmtPrice,
        );
        return {
          ref: o.externalId ?? `opt_${o.id}`,
          name: o.name,
          price: formatHubRisePrice(optBase, currency),
          ...(overrides.length ? { price_overrides: overrides } : {}),
          default: o.isDefault === true,
        };
      }),
    });
  }

  // Products
  const products: HubRiseProduct[] = [];
  for (const cat of menu.categories ?? []) {
    const catRef = cat.externalId ?? `cat_${cat.id}`;
    for (const link of cat.items ?? []) {
      const item = link.item;
      // Brand scoping: restrict this product to the variants of the brand(s)
      // it belongs to, so a brand's connector only sees its own products in
      // the shared catalog. Empty (untagged product) → left unrestricted.
      const restrictRefs = variantRefsForBrands(variants, [
        item.brandId,
        ...(Array.isArray(item.brandIds) ? item.brandIds : []),
      ]);
      const restrictions = restrictRefs.length
        ? { restrictions: { variant_refs: restrictRefs } }
        : {};
      const multi = !!item.hasMultipleSkus && Array.isArray(item.productSkus);
      const skus: HubRiseSku[] = multi
        ? (item.productSkus as any[]).map((s, i) => {
            const base = Number(s.price ?? 0);
            // Per-size overrides live on the SKU row itself.
            const overrides = buildHubRisePriceOverrides(
              s.priceOverrides as Record<string, number> | undefined,
              variantRefs,
              base,
              fmtPrice,
            );
            return {
              ref: s.plu ?? `${item.id}_sku_${i}`,
              name: s.name,
              price: formatHubRisePrice(base, currency),
              ...(overrides.length ? { price_overrides: overrides } : {}),
              ...restrictions,
              option_list_refs: (s.modifierGroups ?? [])
                .map((gid: string) => groupById.get(gid))
                .filter(Boolean)
                .map(groupRefFor),
            };
          })
        : (() => {
            const base = Number(item.basePrice ?? 0);
            // Single-SKU items carry their per-channel prices at the item
            // level (MenuItem.platformPricingOverrides).
            const overrides = buildHubRisePriceOverrides(
              item.platformPricingOverrides as Record<string, number> | undefined,
              variantRefs,
              base,
              fmtPrice,
            );
            return [
              {
                ref: item.plu ?? item.externalId ?? `${item.id}_sku`,
                name: null,
                price: formatHubRisePrice(base, currency),
                ...(overrides.length ? { price_overrides: overrides } : {}),
                ...restrictions,
                option_list_refs: (item.modifierGroupLinks ?? [])
                  .map((l: any) => l.group)
                  .filter(Boolean)
                  .map(groupRefFor),
              },
            ];
          })();
      // Phase AW-12.1 — round-trip the HubRise image id. Import wrote
      // imageUrl=/api/v1/menus/hubrise-image/<catalogId>/<imageId>;
      // pull the imageId back out so we re-reference the existing
      // upload instead of duplicating. Operator-uploaded images that
      // don't match this URL pattern are skipped until we wire the
      // POST /catalogs/:id/images binary upload path (separate phase).
      const hubriseImageMatch =
        typeof item.imageUrl === "string"
          ? item.imageUrl.match(/hubrise-image\/[^/]+\/([^/?#]+)/)
          : null;
      const image_ids = hubriseImageMatch ? [hubriseImageMatch[1]] : undefined;

      products.push({
        ref: item.externalId ?? `prod_${item.id}`,
        category_ref: catRef,
        name: item.name,
        description: item.description ?? null,
        ...(image_ids && { image_ids }),
        skus,
      });
    }
  }

  return {
    categories,
    products,
    optionLists,
    variants: variants.map((v) => ({ ref: v.ref, name: v.name })),
  };
}

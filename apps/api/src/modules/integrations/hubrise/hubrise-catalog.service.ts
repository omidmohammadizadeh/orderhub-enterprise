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

import { Injectable, Logger, NotFoundException, BadRequestException, Optional } from "@nestjs/common";
import { createHash } from "crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { resolveHubRiseTarget, type HubRiseTarget } from "./hubrise-target.resolver";
import {
  composeAutoMaster,
  findDuplicateRefs,
  isAutoMasterMember,
  type AutoMasterMember,
  type ComposedAutoMaster,
} from "./hubrise-auto-master.composer";
import { ActivityLogService } from "../../logs/activity-log.service";
import {
  normalizePricingVariants,
  buildHubRisePriceOverrides,
  resolveOverridesForVariants,
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
  // Internal-only (stripped before the payload is sent): the item's image URL
  // and id, so the publish step can upload the image INTO the target catalog and
  // set image_ids when it isn't already there.
  _srcImageUrl?: string;
  _itemId?: string;
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
    @Optional() private readonly activity?: ActivityLogService,
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

      // Duplicate guard, two tiers. Tier 1: the import-source identity
      // (brandId + HUBRISE + externalId) — the normal re-import path.
      // Tier 2 (added after the 2026-07 duplicate-catalog cleanup): match
      // by NAME within the same brand+location. Historical imports left
      // "manual"-source copies with no externalId; without this fallback a
      // re-import couldn't see them and created a full twin set of every
      // product (PIZZA UNO ended up with 7 copies of its whole menu).
      // Adopting the name-match — and stamping the HubRise identity onto
      // it — means the next import matches on tier 1 again.
      let existing = await (this.prisma as any).menuItem.findFirst({
        where: {
          brandId: target.brandId,
          platformSource: "HUBRISE",
          externalId: productExternal,
        },
        select: { id: true },
      });
      if (!existing && product.name) {
        existing = await (this.prisma as any).menuItem.findFirst({
          where: {
            brandId: target.brandId,
            locationId: target.locationId,
            name: { equals: String(product.name).trim(), mode: "insensitive" },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
      }
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
              // Stamp the import identity so the item is found by tier 1
              // next time even if it started life as a manual copy.
              platformSource: "HUBRISE",
              externalId: productExternal,
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

  /**
   * Ensure each product's image exists in the TARGET catalog. Products flagged
   * with _srcImageUrl carry an image that lives elsewhere (another HubRise
   * catalog, or an external URL) — fetch its bytes and upload them into this
   * catalog, then set image_ids. On success the item's imageUrl is re-pointed at
   * the new catalog so future publishes reference it directly (no re-upload).
   * Any failure is logged and skipped — an image must never break the publish.
   */
  private async attachProductImages(
    jobs: Array<{ product: HubRiseProduct; src: string; itemId?: string }>,
    catalogId: string,
    accessToken: string,
    tenantId?: string,
  ): Promise<number> {
    const cache = new Map<string, string | null>(); // source URL → new image id
    let uploaded = 0;
    for (const job of jobs) {
      const { product, src, itemId } = job;
      let newId = cache.get(src);
      if (newId === undefined) {
        try {
          const bytes =
            (await this.resolveImageBytes(src, accessToken, tenantId).catch(
              () => null,
            )) ??
            (itemId && tenantId
              ? await this.resolveImageViaTwin(itemId, src, accessToken, tenantId)
              : null);
          // Stable ref so HubRise dedupes if the same image is re-uploaded.
          const privateRef = createHash("md5").update(src).digest("hex").slice(0, 24);
          newId = bytes
            ? await this.uploadImageToCatalog(catalogId, accessToken, bytes.buffer, bytes.contentType, privateRef)
            : null;
        } catch (e: any) {
          this.logger.warn(`HubRise image upload failed for ${src}: ${e?.message ?? e}`);
          newId = null;
        }
        cache.set(src, newId);
        if (newId) uploaded++;
      }

      if (newId) {
        product.image_ids = [newId];
        if (itemId) {
          await (this.prisma as any).menuItem
            .update({
              where: { id: itemId },
              data: { imageUrl: `/api/v1/menus/hubrise-image/${catalogId}/${newId}` },
            })
            .catch(() => null);
        }
      }
    }
    return uploaded;
  }

  /**
   * Background: upload each product's image into the catalog, then re-PUT so the
   * new image_ids land. Runs AFTER the publish response so a big image set never
   * blocks (or times out) the operator's publish click.
   */
  private async uploadImagesThenRepublish(
    catalogId: string,
    accessToken: string,
    credentials: unknown,
    jobs: Array<{ product: HubRiseProduct; src: string; itemId?: string }>,
    menuName: string,
    data: HubRiseCatalogData,
    tenantId?: string,
  ): Promise<void> {
    const uploaded = await this.attachProductImages(jobs, catalogId, accessToken, tenantId);
    if (uploaded > 0) {
      await this.callHubRise("PUT", `/catalogs/${catalogId}`, credentials, {
        name: menuName,
        data,
      });
      this.logger.log(`HubRise images: re-published catalog ${catalogId} with ${uploaded} image(s)`);
    }
  }

  /**
   * Fetch the raw bytes of an image referenced by a HubRise-proxy or http(s) URL.
   *
   * `accessToken` is the token of the location we're publishing FOR. Try it
   * first, because fetchHubRiseImage resolves credentials by looking for a
   * Location whose hubriseCatalogId equals the catalog in the URL — and that
   * column holds only the CURRENT catalog. An item imported from an older
   * catalog (a Deliveroo import, or a menu published before the catalog was
   * recreated) points at an id no location claims any more, so the lookup
   * threw "HubRise catalog not found" and the image was dropped. The catalog
   * is still readable with this account's token; nothing was wrong but where
   * we looked for the key.
   */
  private async resolveImageBytes(
    src: string,
    accessToken?: string,
    tenantId?: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const m = src.match(/hubrise-image\/([^/]+)\/([^/?#]+)/);
    if (m && m[1] && m[2]) {
      if (accessToken) {
        const direct = await this.fetchCatalogImageWithToken(
          m[1],
          m[2],
          accessToken,
        ).catch(() => null);
        if (direct) return direct;
      }
      // The publishing token couldn't read it, so the catalog belongs to a
      // different HubRise account — which is the normal case for a master
      // menu assembled from brands that each connected HubRise separately.
      // Try this tenant's other HubRise connections before giving up.
      if (tenantId) {
        const viaSibling = await this.fetchCatalogImageAcrossTenant(
          m[1],
          m[2],
          tenantId,
        );
        if (viaSibling) return viaSibling;
      }
      return this.fetchHubRiseImage(m[1], m[2]);
    }
    if (/^https?:\/\//i.test(src)) {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`fetch image ${src} → ${res.status}`);
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get("content-type") ?? "image/jpeg",
      };
    }
    // A relative, non-HubRise URL we can't resolve to bytes — skip.
    return null;
  }

  /**
   * Read one catalog image with an explicit token, skipping the
   * hubriseCatalogId → Location lookup entirely. Catalogs are readable by
   * any token on the same HubRise account, so the publishing location's own
   * token opens the older catalogs its menus were imported from.
   */
  private async fetchCatalogImageWithToken(
    catalogId: string,
    imageId: string,
    accessToken: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const baseUrl =
      this.config.get<string>("app.platforms.hubrise.baseUrl") ??
      "https://api.hubrise.com/v1";
    const res = await fetch(
      `${baseUrl}/catalogs/${catalogId}/images/${imageId}/data`,
      { headers: { "X-Access-Token": accessToken } },
    );
    if (!res.ok) return null;
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "image/jpeg",
    };
  }

  /**
   * Last resort: try every HubRise connection this TENANT has until one can
   * read the catalog.
   *
   * A master menu is assembled from menus that were imported for different
   * brands, and each brand connected HubRise on its own account. The catalog
   * an image was imported from therefore usually belongs to a sibling
   * location, not the one being published — and Location.hubriseCatalogId
   * only ever holds that location's CURRENT catalog, so once it republishes,
   * nothing in the database points at the old catalog at all.
   *
   * Scoped to the tenant on purpose: this walks stored credentials, so it
   * must never reach another operator's account. The winning token is cached
   * per catalog so a 60-image menu costs one search, not sixty.
   */
  // Lazily created, not a field initialiser: this class is also constructed
  // via Object.create in tests, and an undefined Map here would throw inside
  // the image loop — which is caught and logged, so it would show up as
  // "image dropped" rather than as the bug it is.
  private catalogTokenCache?: Map<string, string>;

  private async fetchCatalogImageAcrossTenant(
    catalogId: string,
    imageId: string,
    tenantId: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const tokenCache = (this.catalogTokenCache ??= new Map<string, string>());
    const cached = tokenCache.get(catalogId);
    if (cached) {
      const hit = await this.fetchCatalogImageWithToken(
        catalogId,
        imageId,
        cached,
      ).catch(() => null);
      if (hit) return hit;
    }

    const locations = await (this.prisma as any).location.findMany({
      where: {
        brand: { tenantId },
        hubriseCredentials: { not: null } as any,
        deletedAt: null,
      },
      select: { id: true, hubriseCredentials: true },
      take: 50,
    });

    for (const loc of locations) {
      let token: string | undefined;
      try {
        const decrypted = this.credentialEncryption.decrypt(
          (loc.hubriseCredentials ?? {}) as Record<string, unknown>,
        ) as Record<string, string>;
        token = decrypted.accessToken;
      } catch {
        continue;
      }
      if (!token || token === cached) continue;
      const hit = await this.fetchCatalogImageWithToken(
        catalogId,
        imageId,
        token,
      ).catch(() => null);
      if (hit) {
        tokenCache.set(catalogId, token);
        this.logger.log(
          `HubRise catalog ${catalogId} resolved via sibling location ${loc.id}`,
        );
        return hit;
      }
    }
    return null;
  }

  /** Sniff an image's real mime type from its magic bytes (S3 often mislabels). */
  private sniffImageMime(buf: Buffer): string | null {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    return null;
  }

  // HubRise caps catalog images at 1 MB.
  private static readonly HUBRISE_MAX_IMAGE_BYTES = 1_000_000;

  /**
   * Bring an oversized photo under HubRise's 1 MB cap by resizing and
   * re-encoding as JPEG, stepping down until it fits. A menu tile is a few
   * hundred pixels; the 2 MB marketplace original buys nothing.
   *
   * sharp is required lazily and every failure returns null: it is a native
   * module, and if a deploy ever ships without a working binary the publish
   * must degrade to "this one image was skipped" — the behaviour before this
   * existed — rather than take the whole catalog down with it.
   */
  private async compressForHubRise(
    buffer: Buffer,
  ): Promise<{ buffer: Buffer; mime: string } | null> {
    let sharp: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sharp = require("sharp");
    } catch {
      return null;
    }
    const steps = [
      { width: 1600, quality: 80 },
      { width: 1200, quality: 72 },
      { width: 900, quality: 62 },
      { width: 700, quality: 50 },
    ];
    for (const step of steps) {
      try {
        const out: Buffer = await sharp(buffer)
          // Honour EXIF orientation before dropping the metadata with it.
          .rotate()
          .resize({ width: step.width, withoutEnlargement: true })
          // Flatten onto white: a transparent PNG becomes black in JPEG.
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: step.quality, mozjpeg: true })
          .toBuffer();
        if (out.length <= HubRiseCatalogService.HUBRISE_MAX_IMAGE_BYTES) {
          return { buffer: out, mime: "image/jpeg" };
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Upload image bytes to a HubRise catalog; returns the new image id. Per the
   * HubRise Catalog API, the image binary is the RAW request body and the mime
   * type goes in the Content-Type header (NOT JSON, NOT multipart). Accepted:
   * jpeg/png/webp/gif/bmp, max 1 MB. A stable private_ref dedupes re-uploads.
   */
  private async uploadImageToCatalog(
    catalogId: string,
    accessToken: string,
    buffer: Buffer,
    contentType: string,
    privateRef?: string,
  ): Promise<string | null> {
    const baseUrl =
      this.config.get<string>("app.platforms.hubrise.baseUrl") ??
      "https://api.hubrise.com/v1";
    let mime = ((contentType || "").toLowerCase().split(";")[0] ?? "").trim();
    if (mime === "image/jpg") mime = "image/jpeg";
    if (!/^image\/(jpeg|png|gif|webp|bmp)$/.test(mime)) {
      mime = this.sniffImageMime(buffer) ?? "image/jpeg";
    }
    if (buffer.length > HubRiseCatalogService.HUBRISE_MAX_IMAGE_BYTES) {
      // Source photos come off the marketplace CDNs at 1.5–2 MB, over
      // HubRise's 1 MB cap, and used to be thrown away — an operator whose
      // menu came from Deliveroo simply got no pictures. Shrink instead:
      // nobody needs a 2 MB PNG on a menu tile.
      const shrunk = await this.compressForHubRise(buffer);
      if (!shrunk) {
        throw new Error(
          `image is ${Math.round(buffer.length / 1024)}KB — HubRise max is 1MB (could not compress)`,
        );
      }
      this.logger.log(
        `HubRise image compressed ${Math.round(buffer.length / 1024)}KB → ${Math.round(shrunk.buffer.length / 1024)}KB`,
      );
      buffer = shrunk.buffer;
      mime = shrunk.mime;
    }
    const qs = privateRef ? `?private_ref=${encodeURIComponent(privateRef)}` : "";
    const res = await fetch(`${baseUrl}/catalogs/${catalogId}/images${qs}`, {
      method: "POST",
      headers: { "X-Access-Token": accessToken, "Content-Type": mime },
      body: new Uint8Array(buffer),
    });
    let text = await res.text();
    // HubRise does NOT dedupe on private_ref — it REJECTS the upload with
    // 422 "is already used". The ref only ever helps the first time; every
    // republish of an image already in this catalog came back 422, the
    // caller logged it, and the product silently lost its picture. Retry
    // once without the ref so the product keeps an image. It costs a
    // duplicate blob in the catalog, which is far cheaper than a menu of
    // items with no photos.
    if (
      !res.ok &&
      res.status === 422 &&
      privateRef &&
      /private_ref/i.test(text) &&
      /already/i.test(text)
    ) {
      const retry = await fetch(`${baseUrl}/catalogs/${catalogId}/images`, {
        method: "POST",
        headers: { "X-Access-Token": accessToken, "Content-Type": mime },
        body: new Uint8Array(buffer),
      });
      text = await retry.text();
      if (!retry.ok) {
        throw new Error(
          `HubRise POST /catalogs/${catalogId}/images (retry, no private_ref) → ${retry.status}: ${text.slice(0, 300)}`,
        );
      }
      try {
        const j = JSON.parse(text);
        return j?.id ?? j?.image_id ?? null;
      } catch {
        return null;
      }
    }
    if (!res.ok) {
      throw new Error(`HubRise POST /catalogs/${catalogId}/images → ${res.status}: ${text.slice(0, 300)}`);
    }
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* empty body on some responses */
    }
    return json?.id ?? json?.image_id ?? null;
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

    // Resolve WHERE to publish. resolveHubRiseTarget prefers a per-brand
    // HUBRISE BrandPlatformConnection (one HubRise location per brand, so a
    // virtual brand gets its own catalog instead of sharing a merged master
    // menu) and otherwise falls back to the legacy Location columns with the
    // exact rules they always had — never a deleted location, and the menu's
    // own location before any same-brand connected one. Both learned from a
    // live bug where publishes 200'd against an orphaned catalog.
    const target = await resolveHubRiseTarget(this.prisma, {
      tenantId: args.tenantId,
      brandId: menu.brandId,
      locationId: menu.locationId ?? null,
    });
    if (!target) {
      throw new BadRequestException(
        "No HubRise-connected location for this menu's brand. Connect HubRise on a location first.",
      );
    }
    // Shaped like the row this function used to select, so everything below
    // is unchanged.
    const location = {
      id: target.locationId,
      hubriseCredentials: target.hubriseCredentials,
      hubriseCatalogId: target.hubriseCatalogId,
      hubriseLocationId: target.hubriseLocationId,
    };
    this.logger.log(
      `HubRise publish menu=${args.menuId} brand=${menu.brandId} ` +
        `via ${target.source} → hubriseLocation=${target.hubriseLocationId} ` +
        `catalog=${target.hubriseCatalogId ?? "(new)"}`,
    );

    // ── Auto-composed master menu ──────────────────────────────────────
    // When this location's menus opted into a composed catalog, the payload
    // we push is EVERY member brand's menu merged in memory — never just the
    // one the operator clicked. See hubrise-auto-master.composer.ts for why
    // sending only the clicked brand is the one thing this feature must never
    // do. With no members (the state of every location today) `composition`
    // stays null and everything below runs on the single menu exactly as it
    // always has, including the hand-built master-menu path.
    const composition = await this.composeAutoMasterIfMember({
      tenantId: args.tenantId,
      menuId: args.menuId,
      menuName: menu.name,
      target,
    });
    const sourceMenu: any = composition?.menu ?? menu;
    const catalogName: string = composition ? composition.menu.name : menu.name;
    const publishedMenuIds: string[] = composition?.memberIds ?? [args.menuId];

    // Phase AW-11.4 — collect every modifier group referenced by ANY
    // product in this menu, from both the link table (single-SKU
    // products) AND the productSkus JSON (multi-SKU products). Then
    // fetch them once with their options so the transformer can emit
    // a complete option_lists array AND resolve every SKU's group ids
    // to a real ref.
    const referencedGroupIds = new Set<string>();
    for (const cat of sourceMenu.categories ?? []) {
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
      transformMenuToCatalog(
        sourceMenu,
        groupById,
        location.hubriseCatalogId ?? undefined,
      );

    if (composition) {
      // The payload must be COMPLETE. A member that contributed no products
      // means that brand's storefront would go dark on this publish, so the
      // whole publish is refused rather than shipping a partial catalog.
      const starved = composition.memberIds.filter(
        (id) => (composition.productCounts.get(id) ?? 0) === 0,
      );
      if (starved.length) {
        const names = starved
          .map((id) => composition.memberNames.get(id) ?? id)
          .map((n) => `"${n}"`)
          .join(", ");
        throw new BadRequestException(
          `${names} ${starved.length === 1 ? "is" : "are"} part of this ` +
            `location's HubRise catalog but ${starved.length === 1 ? "has" : "have"} ` +
            `no products, so publishing would take that brand's storefront down. ` +
            `Add products to it, or remove it from the HubRise catalog.`,
        );
      }

      // Two brands' menus can carry the same PLU or the same imported
      // externalId; the hand-built master menu couldn't, because it deep-copies
      // with fresh PLUs. A duplicate ref silently merges or drops a product in
      // HubRise, so refuse and name both rows.
      const duplicates = findDuplicateRefs({ categories, products, optionLists });
      if (duplicates.length) {
        this.logger.error(
          `HubRise auto-master: duplicate refs across member menus — ${duplicates.join("; ")}`,
        );
        throw new BadRequestException(
          `The brands sharing this location's HubRise catalog use the same ` +
            `reference for different things, which HubRise can't store: ` +
            `${duplicates.slice(0, 3).join("; ")}` +
            `${duplicates.length > 3 ? ` (and ${duplicates.length - 3} more)` : ""}. ` +
            `Give one of each pair a different PLU and publish again.`,
        );
      }
    }

    // ── Empty-catalog guard ────────────────────────────────────────────
    // Publishing an empty menu REPLACES the live catalog with nothing, which
    // takes down every storefront fed by it. This is not hypothetical: on
    // 17 Jul 2026 two different zero-item menus were published into Clifton's
    // catalog 622ex within two hours, and six near-identically named menus at
    // that one location still all target it. A menu with no products is
    // always an operator picking the wrong row from a list of duplicates —
    // never a real intention to clear a shop's menu.
    //
    // Refuse it. Emptying a catalog deliberately is a HubRise-side action,
    // not something a POS publish button should be able to do by accident.
    if (products.length === 0) {
      throw new BadRequestException(
        `"${menu.name}" has no products, so publishing it would empty the ` +
          `live HubRise catalog and take the storefronts down. Check you ` +
          `picked the right menu — this location has more than one.`,
      );
    }

    const skuOverrideCount = products.reduce(
      (n, p) => n + (p.skus ?? []).filter((s: any) => s.price_overrides?.length).length,
      0,
    );
    this.logger.log(
      `HubRise publish: menu=${args.menuId} → location=${location.id} ` +
        `catalog=${location.hubriseCatalogId ?? "NEW"} ` +
        `hubriseLocation=${location.hubriseLocationId} ` +
        `categories=${categories.length} ` +
        `products=${products.length} optionLists=${optionLists.length} ` +
        `variants=${variants.length} skusWithPriceOverrides=${skuOverrideCount} ` +
        `referencedGroups=${referencedGroupIds.size}` +
        (composition
          ? ` autoMaster=[${composition.memberIds.join(",")}]` +
            ` sharedItems=${composition.sharedItemCount}` +
            ` seededVariantBrands=[${composition.seededBrandIds.join(",")}]`
          : ""),
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

    // Decrypt the HubRise token once — used to upload images into the catalog.
    const hubriseToken = (() => {
      try {
        const d = this.credentialEncryption.decrypt(
          (location.hubriseCredentials ?? {}) as Record<string, unknown>,
        ) as Record<string, string>;
        return d.accessToken ?? null;
      } catch {
        return null;
      }
    })();

    // Capture the images that need uploading, THEN strip the internal fields so
    // they never reach HubRise. Uploads happen in the background after the PUT.
    const imageJobs = products
      .filter((p) => p._srcImageUrl)
      .map((p) => ({ product: p, src: p._srcImageUrl as string, itemId: p._itemId }));
    for (const p of products) {
      delete p._srcImageUrl;
      delete p._itemId;
    }

    // ── A republish must never turn a photo into plain text ────────────
    // The catalog PUT replaces everything, so a product we send without
    // `image_ids` LOSES the photo HubRise is already showing. That happens
    // whenever an item's imageUrl points at a catalog we can no longer read
    // (deleted, recreated, or on an account whose token we don't hold) — the
    // upload below fails and the product would go out bare.
    //
    // So before sending, read the live catalog and carry its existing image
    // ids onto any product that hasn't got one. The background upload still
    // runs and replaces them with a fresh id when it can; when it can't, the
    // photo simply stays as it was instead of disappearing.
    const imagesCarried = location.hubriseCatalogId
      ? await this.carryOverCatalogImages(
          location.hubriseCatalogId,
          location.hubriseCredentials,
          products,
        )
      : 0;
    const withPhoto = products.filter((p) => p.image_ids?.length).length;
    this.logger.log(
      `HubRise publish images: products=${products.length} ` +
        `withPhoto=${withPhoto} carriedFromCatalog=${imagesCarried} ` +
        `uploadsQueued=${imageJobs.length} ` +
        `stillPlain=${products.length - withPhoto - imageJobs.filter((j) => !j.product.image_ids?.length).length}`,
    );

    const data: HubRiseCatalogData = {
      // Only send variants[] when the menu actually defines some — an
      // empty array is harmless but noise in HubRise's UI.
      ...(variants.length ? { variants } : {}),
      categories,
      products,
      option_lists: optionLists,
    };

    if (location.hubriseCatalogId) {
      // Publish the catalog immediately (fast). Images upload in the background
      // and re-publish once done — never blocking the operator's click.
      await this.callHubRise(
        `PUT`,
        `/catalogs/${location.hubriseCatalogId}`,
        location.hubriseCredentials,
        { name: catalogName, data },
      );
      if (hubriseToken && imageJobs.length) {
        const catId = location.hubriseCatalogId;
        const creds = location.hubriseCredentials;
        setImmediate(() =>
          this.uploadImagesThenRepublish(catId, hubriseToken, creds, imageJobs, catalogName, data, args.tenantId).catch(
            (err: any) => this.logger.warn(`HubRise background image upload failed: ${err?.message ?? err}`),
          ),
        );
      }
      await this.markPublished(publishedMenuIds, location.hubriseCatalogId);
      this.activity?.record({
        tenantId: args.tenantId,
        brandId: menu.brandId ?? null,
        locationId: location.id,
        category: "MENU",
        channel: "HUBRISE",
        action: "menu.publish",
        status: "SUCCESS",
        message: composition
          ? `${composition.memberIds.length} brand menus published to HubRise as one catalog (triggered by "${menu.name}")`
          : `Menu "${menu.name}" published to HubRise (catalog updated)`,
        details: {
          catalogId: location.hubriseCatalogId,
          products: products.length,
          ...(composition ? { autoMasterMenuIds: composition.memberIds } : {}),
        },
      });
      return { catalogId: location.hubriseCatalogId, created: false };
    }

    const created = (await this.callHubRise(
      "POST",
      `/locations/${location.hubriseLocationId.toLowerCase()}/catalogs`,
      location.hubriseCredentials,
      { name: catalogName, data },
    )) as { id: string };

    await (this.prisma as any).location.update({
      where: { id: location.id },
      data: { hubriseCatalogId: created.id },
    });

    // Images can only be uploaded once the catalog exists. Do it in the
    // background and re-publish once done — never blocking the publish response.
    if (hubriseToken && imageJobs.length) {
      const creds = location.hubriseCredentials;
      setImmediate(() =>
        this.uploadImagesThenRepublish(created.id, hubriseToken, creds, imageJobs, catalogName, data, args.tenantId).catch(
          (err: any) => this.logger.warn(`HubRise background image upload failed: ${err?.message ?? err}`),
        ),
      );
    }
    await this.markPublished(publishedMenuIds, created.id);
    this.activity?.record({
      tenantId: args.tenantId,
      brandId: menu.brandId ?? null,
      locationId: location.id,
      category: "MENU",
      channel: "HUBRISE",
      action: "menu.publish",
      status: "SUCCESS",
      message: composition
        ? `${composition.memberIds.length} brand menus published to HubRise as one new catalog (triggered by "${menu.name}")`
        : `Menu "${menu.name}" published to HubRise (new catalog)`,
      details: {
        catalogId: created.id,
        products: products.length,
        ...(composition ? { autoMasterMenuIds: composition.memberIds } : {}),
      },
    });
    return { catalogId: created.id, created: true };
  }

  /**
   * Load this location's auto-composed HubRise catalog and merge it, when the
   * menu being published belongs to one.
   *
   * Returns null — leaving the caller on the untouched single-menu path — when
   * the location has no member menus (every location today) or when the target
   * is a per-brand HubRise connection, which already has a catalog to itself
   * and must not be handed every other brand's products.
   *
   * Throws when a NON-member menu is published into a composed catalog: that
   * PUT would replace all the member brands with one brand's items and strip
   * the variants every operator selected in HubRise. It is exactly the
   * accident this feature exists to prevent, so it is refused rather than
   * quietly published.
   */
  private async composeAutoMasterIfMember(args: {
    tenantId: string;
    menuId: string;
    menuName: string;
    target: HubRiseTarget;
  }): Promise<ComposedAutoMaster | null> {
    const { target } = args;
    if (target.source !== "location" || !target.locationId) return null;
    const locationId = target.locationId;

    // Same "belongs to this location" rule the Menu tab lists by (homed here,
    // or serving here via an assignment row), so what the operator ticked in
    // the picker is what composes.
    const atLocation = { OR: [{ locationId }, { assignments: { some: { locationId } } }] };

    // Cheap pass first: only the flag matters, and most locations have none.
    const candidates = await (this.prisma as any).menu.findMany({
      where: { deletedAt: null, brand: { tenantId: args.tenantId }, ...atLocation },
      select: { id: true, metadata: true },
    });
    const memberIds: string[] = candidates
      .filter((m: any) => isAutoMasterMember(m))
      .map((m: any) => m.id as string);
    if (memberIds.length === 0) return null;

    if (!memberIds.includes(args.menuId)) {
      throw new BadRequestException(
        `"${args.menuName}" is not part of this location's HubRise catalog, ` +
          `and publishing it would replace every brand already in that ` +
          `catalog with just this menu. Publish one of the brand menus in the ` +
          `catalog instead, or add this menu to it first.`,
      );
    }

    const members: AutoMasterMember[] = await (this.prisma as any).menu.findMany({
      where: { id: { in: memberIds } },
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
        brand: { select: { id: true, name: true } },
      },
    });

    // The catalog name must not depend on which brand pressed publish, or the
    // HubRise catalog would be renamed on every publish. The location's own
    // name is the one label that is true for all of them.
    const location = await (this.prisma as any).location.findUnique({
      where: { id: locationId },
      select: { name: true },
    });

    const composed = composeAutoMaster(members, {
      name: location?.name || args.menuName,
    });
    this.logger.log(
      `HubRise auto-master: composing ${composed.memberIds.length} menus at ` +
        `location=${locationId} for publish of menu=${args.menuId} ` +
        `(${composed.menu.categories.length} categories, ` +
        `${composed.menu.pricingVariants.length} variants)`,
    );
    return composed;
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

  // Every menu whose products just went into the catalog gets stamped, not
  // only the one the operator clicked. MenuAvailabilityService resolves which
  // HubRise catalog to 86 against from Menu.externalId + lastPublishedAt, so a
  // member menu left unstamped would send its 86s to the wrong catalog — or
  // nowhere at all.
  /**
   * Copy the image ids the live catalog already holds onto any product we're
   * about to publish without one. Keyed by product ref, which is stable across
   * publishes, so a product keeps its photo even when its source image has
   * become unreadable.
   *
   * Never fatal: if the catalog can't be read we publish as we would have
   * anyway. Costs one GET per publish.
   */
  private async carryOverCatalogImages(
    catalogId: string,
    credentials: unknown,
    products: HubRiseProduct[],
  ): Promise<number> {
    let existing: Map<string, string[]>;
    try {
      const catalog = await this.fetchCatalog(catalogId, credentials);
      existing = imageIdsByProductRef(catalog?.data);
    } catch (err: any) {
      this.logger.warn(
        `HubRise: couldn't read catalog ${catalogId} to preserve existing photos — ${err?.message ?? err}`,
      );
      return 0;
    }
    if (existing.size === 0) return 0;

    let carried = 0;
    for (const product of products) {
      if (product.image_ids?.length) continue;
      const ids = product.ref ? existing.get(product.ref) : undefined;
      if (ids?.length) {
        product.image_ids = ids;
        carried++;
      }
    }
    return carried;
  }

  /**
   * Last chance at a product photo: borrow it from a TWIN.
   *
   * The same product exists as several MenuItem rows — clone() and
   * createMasterMenu() both deep-copy — and those copies carry whatever
   * imageUrl the original had at the time. When a location's copies point at a
   * catalog that no longer exists, a twin elsewhere in the tenant usually
   * points at a live one, because attachProductImages re-points an item's
   * imageUrl every time it successfully uploads.
   *
   * Matched on tenant + brand-agnostic name (case-insensitive), the same twin
   * rule the 86 → inventory push already relies on. It only ever runs when the
   * item's OWN image failed, so the worst case is the plain product we would
   * have published anyway. Every hit is logged with both item ids so a wrong
   * match is traceable.
   */
  private async resolveImageViaTwin(
    itemId: string,
    deadSrc: string,
    accessToken: string | undefined,
    tenantId: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const item = await (this.prisma as any).menuItem
      .findUnique({ where: { id: itemId }, select: { id: true, name: true } })
      .catch(() => null);
    if (!item?.name) return null;

    const brandIds = (this.tenantBrandIdCache ??= new Map<string, string[]>());
    let ids = brandIds.get(tenantId);
    if (!ids) {
      const brands = await (this.prisma as any).brand.findMany({
        where: { tenantId },
        select: { id: true },
      });
      ids = brands.map((b: any) => b.id as string);
      brandIds.set(tenantId, ids as string[]);
    }
    if (!ids?.length) return null;

    const twins = await (this.prisma as any).menuItem.findMany({
      where: {
        brandId: { in: ids },
        name: { equals: item.name, mode: "insensitive" },
        id: { not: itemId },
        imageUrl: { not: null },
      },
      select: { id: true, imageUrl: true },
      take: 10,
    });

    for (const twin of twins) {
      const src = twin.imageUrl as string;
      if (!src || src === deadSrc) continue;
      const bytes = await this.resolveImageBytes(src, accessToken, tenantId).catch(
        () => null,
      );
      if (bytes) {
        this.logger.log(
          `HubRise image: "${item.name}" (${itemId}) recovered from twin ${twin.id} — its own source ${deadSrc} is unreadable`,
        );
        return bytes;
      }
    }
    return null;
  }

  private tenantBrandIdCache?: Map<string, string[]>;

  private async markPublished(menuIds: string[], hubriseCatalogId: string) {
    await (this.prisma as any).menu.updateMany({
      where: { id: { in: menuIds } },
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
    // Log write calls so a "published but HubRise didn't change" report can be
    // traced to the exact catalog + HTTP status that HubRise returned.
    if (method !== "GET") {
      this.logger.log(`HubRise ${method} ${path} → ${res.status}`);
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

/**
 * Every product image already stored in a live HubRise catalog, keyed by
 * product ref. Products live either at `data.products` or nested under
 * `data.categories[].products` depending on how the catalog was written, so
 * read both.
 */
export function imageIdsByProductRef(
  data: {
    products?: Array<{ ref?: string | null; image_ids?: string[] }>;
    categories?: Array<{ products?: Array<{ ref?: string | null; image_ids?: string[] }> }>;
  } | null | undefined,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const take = (list?: Array<{ ref?: string | null; image_ids?: string[] }>) => {
    for (const p of list ?? []) {
      if (p?.ref && p.image_ids?.length) out.set(p.ref, p.image_ids);
    }
  };
  take(data?.products);
  for (const c of data?.categories ?? []) take(c?.products);
  return out;
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

// Standalone module-level function (not a class method, no `this.logger`
// available) — its own logger instance for the empty-option-list warning.
const catalogTransformLogger = new Logger("HubRiseCatalogService");

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
export function transformMenuToCatalog(
  menu: any,
  groupById: Map<string, any>,
  // The catalog we're publishing INTO. A HubRise image id only exists inside the
  // catalog it was uploaded to, so we only reference an item's image when it
  // belongs to THIS catalog — otherwise HubRise 422s "image not found" and the
  // whole publish fails (e.g. a master/cloned menu carrying images from other
  // catalogs). Undefined (fresh catalog) → send no image ids.
  targetCatalogId?: string,
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

  // HubRise rejects an option_list with zero options outright (422:
  // "must have at least 1 item(s)"), and it fails the WHOLE publish, not
  // just that one group — a single empty/unpopulated modifier group (e.g.
  // one carried over from a source menu that never got options added)
  // blocks every other product in the menu from publishing too. Skip empty
  // groups from option_lists, and — just as importantly — strip their ref
  // from every product/SKU's option_list_refs below, otherwise HubRise
  // would instead reject the payload for referencing an option_list that
  // was never defined.
  const groupHasOptions = (g: any): boolean =>
    Array.isArray(g?.options) && g.options.length > 0;
  for (const g of groupById.values()) {
    if (!groupHasOptions(g)) {
      catalogTransformLogger.warn(
        `HubRise publish: skipping modifier group "${g.name}" (${g.id}) — it has no options, HubRise would reject the whole catalog`,
      );
    }
  }

  // ModifierGroups + options — emit every group referenced by any
  // product in this menu, deduplicated. Iterate the pre-fetched
  // groupById map (which already covers BOTH modifierGroupLinks and
  // productSkus[].modifierGroups paths) so multi-SKU products' groups
  // are not silently dropped.
  const optionLists: HubRiseOptionList[] = [];
  for (const g of groupById.values()) {
    if (!groupHasOptions(g)) continue;
    const maxSel = g.maxSelections ?? null;
    // HubRise rejects multiple_selection=true when max_selections is 0 or 1
    // (422: "cannot be true when max_selections is 0 or 1") — those are
    // single-select. Only an ADDON group with room for >1 pick (or no max)
    // is genuinely multi-select.
    const multipleSelection =
      g.selectionType === "ADDON" && (maxSel === null || maxSel > 1);
    optionLists.push({
      ref: groupRefFor(g),
      name: g.name,
      min_selections: g.minSelections ?? 0,
      max_selections: maxSel,
      multiple_selection: multipleSelection,
      options: (g.options ?? []).map((o: any) => {
        const optBase = Number(o.priceAdjustment ?? 0);
        const overrides = buildHubRisePriceOverrides(
          resolveOverridesForVariants(
            o.platformPricingOverrides as Record<string, number> | undefined,
            variants,
            [], // shared modifier option → map bare channel keys to all brands
          ),
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
      const itemBrands = [
        item.brandId,
        ...(Array.isArray(item.brandIds) ? item.brandIds : []),
      ];
      const restrictRefs = variantRefsForBrands(variants, itemBrands);
      const restrictions = restrictRefs.length
        ? { restrictions: { variant_refs: restrictRefs } }
        : {};
      const multi = !!item.hasMultipleSkus && Array.isArray(item.productSkus);
      const skus: HubRiseSku[] = multi
        ? (item.productSkus as any[]).map((s, i) => {
            const base = Number(s.price ?? 0);
            // Per-size overrides live on the SKU row itself.
            const overrides = buildHubRisePriceOverrides(
              resolveOverridesForVariants(
                s.priceOverrides as Record<string, number> | undefined,
                variants,
                itemBrands,
              ),
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
                .filter((g: any) => g && groupHasOptions(g))
                .map(groupRefFor),
            };
          })
        : (() => {
            const base = Number(item.basePrice ?? 0);
            // Single-SKU items carry their per-channel prices at the item
            // level (MenuItem.platformPricingOverrides).
            const overrides = buildHubRisePriceOverrides(
              resolveOverridesForVariants(
                item.platformPricingOverrides as Record<string, number> | undefined,
                variants,
                itemBrands,
              ),
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
                  .filter((g: any) => g && groupHasOptions(g))
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
          ? item.imageUrl.match(/hubrise-image\/([^/]+)\/([^/?#]+)/)
          : null;
      // If the image already lives in the catalog we're publishing to, reference
      // it directly. Otherwise (image from another catalog, or an external URL)
      // stash the source so the publish step uploads it INTO the target catalog.
      const directId =
        hubriseImageMatch && hubriseImageMatch[1] === targetCatalogId
          ? hubriseImageMatch[2]
          : null;

      products.push({
        ref: item.externalId ?? `prod_${item.id}`,
        category_ref: catRef,
        name: item.name,
        description: item.description ?? null,
        ...(directId ? { image_ids: [directId] } : {}),
        ...(!directId && item.imageUrl
          ? { _srcImageUrl: item.imageUrl as string, _itemId: item.id as string }
          : {}),
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

// Retail R1 — the shop catalogue: barcoded variants on top of menu items.
//
// A retail product is an ordinary MenuItem in an ordinary menu, so the till,
// the storefront and every marketplace publish see it with no new code. This
// service adds what a shop needs on top: variants with barcodes, a barcode
// index the till can scan against offline, and a spreadsheet import that
// builds the whole catalogue in one go.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { MenusService } from "../menus/menus.service";
import { MenuAssignmentsService } from "../menus/menu-assignments.service";
import { PluService } from "../menus/plu.service";
import { RetailStockService } from "./retail-stock.service";
import {
  barcodeLookupKeys,
  normalizeBarcode,
  normalizeImportRows,
  type ImportError,
  type ImportProduct,
} from "./retail.logic";

export interface BarcodeIndexEntry {
  barcode: string;
  variantId: string;
  menuItemId: string;
  /** "Coke 330ml", or "Oxford Shirt — M / Blue" for a multi-variant product. */
  name: string;
  productName: string;
  variantName: string;
  price: number;
  sku: string | null;
}

export interface VariantInput {
  name?: string;
  options?: Record<string, string>;
  barcode?: string | null;
  sku?: string | null;
  price?: number | null;
  costPrice?: number | null;
  trackStock?: boolean;
  lowStockAt?: number | null;
  isActive?: boolean;
}

/** Hard cap per request; the dashboard sends big sheets in chunks. */
export const IMPORT_MAX_ROWS = 1000;

const num = (d: unknown) => (d === null || d === undefined ? null : Number(d));

@Injectable()
export class RetailCatalogService {
  private readonly logger = new Logger(RetailCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly menus: MenusService,
    private readonly assignments: MenuAssignmentsService,
    private readonly plu: PluService,
    private readonly stock: RetailStockService,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  private async location(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
      select: { id: true, brandId: true, name: true, businessType: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  /** Item ids on the till's menu — the set a scan is allowed to sell. */
  private async tillItemIds(tenantId: string, locationId: string): Promise<string[]> {
    const menu: any = await this.menus.findActiveMenuForLocation(locationId, tenantId);
    const ids = new Set<string>();
    for (const cat of menu?.categories ?? []) {
      for (const link of cat.items ?? []) if (link?.item?.id) ids.add(link.item.id);
    }
    return [...ids];
  }

  /**
   * Every scannable barcode on this location's till, flattened for the POS to
   * cache next to the menu (IndexedDB) so scanning works offline.
   */
  async barcodeIndex(tenantId: string, locationId: string): Promise<BarcodeIndexEntry[]> {
    await this.location(tenantId, locationId);
    const itemIds = await this.tillItemIds(tenantId, locationId);
    if (!itemIds.length) return [];
    const variants = await this.prisma.productVariant.findMany({
      where: { tenantId, menuItemId: { in: itemIds }, isActive: true, barcode: { not: null } },
      include: { menuItem: { select: { name: true, basePrice: true } } },
      orderBy: [{ menuItemId: "asc" }, { sortOrder: "asc" }],
    });
    const perItem = new Map<string, number>();
    for (const v of variants) perItem.set(v.menuItemId, (perItem.get(v.menuItemId) ?? 0) + 1);
    return variants.map((v) => {
      const single = (perItem.get(v.menuItemId) ?? 0) <= 1 && v.name === "Default";
      return {
        barcode: v.barcode!,
        variantId: v.id,
        menuItemId: v.menuItemId,
        name: single ? v.menuItem.name : `${v.menuItem.name} — ${v.name}`,
        productName: v.menuItem.name,
        variantName: v.name,
        price: Number(v.price ?? v.menuItem.basePrice),
        sku: v.sku,
      };
    });
  }

  /**
   * Look a barcode up across the whole business, for a scan the till did not
   * recognise: is it a product we have that just isn't on this till, or is it
   * new? Tolerant of the UPC-A / EAN-13 leading-zero difference.
   */
  async lookupBarcode(tenantId: string, locationId: string, raw: string) {
    await this.location(tenantId, locationId);
    const code = normalizeBarcode(raw);
    if (!code) throw new BadRequestException("That isn't a barcode");
    const variant = await this.prisma.productVariant.findFirst({
      where: { tenantId, barcode: { in: barcodeLookupKeys(code) } },
      include: {
        menuItem: { select: { id: true, name: true, basePrice: true } },
        stockLevels: { where: { locationId }, select: { quantity: true } },
      },
    });
    if (!variant) return { code, found: false as const };
    const onTill = (await this.tillItemIds(tenantId, locationId)).includes(variant.menuItemId);
    return {
      code,
      found: true as const,
      onTill,
      variant: this.variantView(variant),
      product: { id: variant.menuItem.id, name: variant.menuItem.name },
    };
  }

  private variantView(v: any) {
    return {
      id: v.id,
      menuItemId: v.menuItemId,
      name: v.name,
      options: v.options ?? {},
      sku: v.sku,
      barcode: v.barcode,
      price: num(v.price),
      costPrice: num(v.costPrice),
      trackStock: v.trackStock,
      lowStockAt: v.lowStockAt,
      isActive: v.isActive,
      stock: v.stockLevels?.[0]?.quantity ?? 0,
    };
  }

  /**
   * The stock screen: every product on the till's menu with its variants and
   * the count at this location. Products with no variant yet are listed too,
   * so the operator can give them a barcode.
   */
  async listProducts(
    tenantId: string,
    locationId: string,
    opts: { q?: string; lowOnly?: boolean } = {},
  ) {
    await this.location(tenantId, locationId);
    const itemIds = await this.tillItemIds(tenantId, locationId);
    if (!itemIds.length) return { products: [], total: 0 };
    const q = opts.q?.trim();
    const items = await this.prisma.menuItem.findMany({
      where: {
        id: { in: itemIds },
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { plu: { contains: q, mode: "insensitive" } },
                { productVariants: { some: { barcode: { contains: q } } } },
                { productVariants: { some: { sku: { contains: q, mode: "insensitive" } } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        basePrice: true,
        plu: true,
        imageUrl: true,
        productVariants: {
          orderBy: { sortOrder: "asc" },
          include: { stockLevels: { where: { locationId }, select: { quantity: true } } },
        },
      },
      orderBy: { name: "asc" },
    });
    let products = items.map((it) => ({
      id: it.id,
      name: it.name,
      basePrice: Number(it.basePrice),
      plu: it.plu,
      imageUrl: it.imageUrl,
      variants: it.productVariants.map((v) => this.variantView(v)),
    }));
    if (opts.lowOnly) {
      products = products.filter((p) =>
        p.variants.some(
          (v) => v.isActive && v.trackStock && v.stock <= (v.lowStockAt ?? 0),
        ),
      );
    }
    return { products, total: products.length };
  }

  // ── Writing variants ──────────────────────────────────────────────────────

  private async itemForWrite(tenantId: string, menuItemId: string) {
    // MenuItem has brandId but no Prisma relation to Brand, so tenancy is
    // checked through the brand (same as MenusService.assertItemAccess).
    const item = await this.prisma.menuItem.findUnique({
      where: { id: menuItemId },
      select: {
        id: true,
        brandId: true,
        plu: true,
        name: true,
        basePrice: true,
        hasMultipleSkus: true,
        productSkus: true,
        metadata: true,
      },
    });
    const brand = item
      ? await this.prisma.brand.findFirst({ where: { id: item.brandId, tenantId }, select: { id: true } })
      : null;
    if (!item || !brand) throw new NotFoundException("Product not found");
    return item;
  }

  private async nextVariantSku(menuItemId: string, basePlu: string | null) {
    const existing = await this.prisma.productVariant.findMany({
      where: { menuItemId },
      select: { sku: true },
    });
    const taken = new Set(existing.map((e) => e.sku));
    const base = basePlu || `PROD-${menuItemId.slice(-6).toUpperCase()}`;
    if (!taken.has(base) && existing.length === 0) return base;
    for (let n = existing.length + 1; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private barcodeOrNull(raw: unknown): string | null {
    if (raw === null || raw === undefined || raw === "") return null;
    const code = normalizeBarcode(raw);
    if (!code) throw new BadRequestException("That isn't a valid barcode");
    return code;
  }

  private rethrowBarcodeClash(err: unknown, barcode: string | null): never {
    if ((err as { code?: string } | null)?.code === "P2002") {
      throw new ConflictException(`Barcode ${barcode ?? ""} is already on another product`);
    }
    throw err;
  }

  async createVariant(tenantId: string, menuItemId: string, input: VariantInput) {
    const item = await this.itemForWrite(tenantId, menuItemId);
    const barcode = this.barcodeOrNull(input.barcode);
    const sku = input.sku?.trim() || (await this.nextVariantSku(item.id, item.plu));
    const count = await this.prisma.productVariant.count({ where: { menuItemId } });
    try {
      const v = await this.prisma.productVariant.create({
        data: {
          tenantId,
          brandId: item.brandId,
          menuItemId,
          name: input.name?.trim() || (count === 0 ? "Default" : `Variant ${count + 1}`),
          options: (input.options ?? {}) as Prisma.InputJsonValue,
          sku,
          barcode,
          price: input.price ?? null,
          costPrice: input.costPrice ?? null,
          trackStock: input.trackStock ?? true,
          lowStockAt: input.lowStockAt ?? null,
          sortOrder: count,
        },
      });
      await this.syncProductSkus(menuItemId);
      return this.variantView(v);
    } catch (err) {
      this.rethrowBarcodeClash(err, barcode);
    }
  }

  async updateVariant(tenantId: string, variantId: string, input: VariantInput) {
    const existing = await this.prisma.productVariant.findFirst({
      where: { id: variantId, tenantId },
      select: { id: true, menuItemId: true },
    });
    if (!existing) throw new NotFoundException("Variant not found");
    const barcode = input.barcode === undefined ? undefined : this.barcodeOrNull(input.barcode);
    try {
      const v = await this.prisma.productVariant.update({
        where: { id: variantId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() || "Default" } : {}),
          ...(input.options !== undefined ? { options: input.options as Prisma.InputJsonValue } : {}),
          ...(barcode !== undefined ? { barcode } : {}),
          ...(input.sku !== undefined ? { sku: input.sku?.trim() || null } : {}),
          ...(input.price !== undefined ? { price: input.price } : {}),
          ...(input.costPrice !== undefined ? { costPrice: input.costPrice } : {}),
          ...(input.trackStock !== undefined ? { trackStock: input.trackStock } : {}),
          ...(input.lowStockAt !== undefined ? { lowStockAt: input.lowStockAt } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await this.syncProductSkus(existing.menuItemId);
      return this.variantView(v);
    } catch (err) {
      this.rethrowBarcodeClash(err, barcode ?? null);
    }
  }

  /**
   * Mirror a product's variants into productSkus so the till's size picker,
   * the storefront and marketplace publishes all offer them.
   *
   * Only touches sizes this service wrote (metadata.retailSkus): a
   * restaurant's hand-built pizza sizes, with their per-size modifier groups,
   * are never overwritten because someone added a barcode.
   */
  async syncProductSkus(menuItemId: string): Promise<void> {
    const item = await this.prisma.menuItem.findUnique({
      where: { id: menuItemId },
      select: { basePrice: true, hasMultipleSkus: true, productSkus: true, metadata: true },
    });
    if (!item) return;
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const ownsSkus = meta.retailSkus === true;
    const handBuilt =
      !ownsSkus && item.hasMultipleSkus && Array.isArray(item.productSkus) && item.productSkus.length > 0;
    if (handBuilt) return;

    const variants = await this.prisma.productVariant.findMany({
      where: { menuItemId, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { name: true, sku: true, price: true },
    });
    if (variants.length > 1) {
      const previous = new Map(
        ((item.productSkus as any[]) ?? []).map((s: any) => [s?.plu, s]),
      );
      await this.prisma.menuItem.update({
        where: { id: menuItemId },
        data: {
          hasMultipleSkus: true,
          productSkus: variants.map((v) => ({
            name: v.name,
            plu: v.sku ?? "",
            price: Number(v.price ?? item.basePrice),
            // Keep any add-ons an operator attached to this size by hand.
            modifierGroups: (previous.get(v.sku) as any)?.modifierGroups ?? [],
          })) as Prisma.InputJsonValue,
          metadata: { ...meta, retailSkus: true } as Prisma.InputJsonValue,
        },
      });
    } else if (ownsSkus) {
      await this.prisma.menuItem.update({
        where: { id: menuItemId },
        data: {
          hasMultipleSkus: false,
          productSkus: [] as Prisma.InputJsonValue,
          // A single variant with its own price is the product's price.
          ...(variants[0]?.price != null ? { basePrice: variants[0].price } : {}),
          metadata: { ...meta, retailSkus: false } as Prisma.InputJsonValue,
        },
      });
    }
  }

  // ── The shop's menu ───────────────────────────────────────────────────────

  /**
   * The menu imported products go into: whatever the till already serves, or
   * a new "Shop" menu published to this location's till.
   */
  async ensureShopMenu(tenantId: string, locationId: string, userId?: string) {
    const loc = await this.location(tenantId, locationId);
    // Exactly the menu findActiveMenuForLocation serves (published, POS) —
    // importing into a draft would put products nowhere the till can see.
    const assigned = await this.assignments.resolveAssignedMenuId({
      locationId,
      channel: "POS",
      preferBrandId: loc.brandId,
      requirePublished: true,
    });
    const existingId =
      assigned ??
      (
        await this.prisma.menu.findFirst({
          where: { locationId, status: "PUBLISHED", deletedAt: null, publishedTo: { has: "POS" } },
          orderBy: [{ lastPublishedAt: "desc" }, { updatedAt: "desc" }],
          select: { id: true },
        })
      )?.id;
    if (existingId) {
      const menu = await this.prisma.menu.findUnique({
        where: { id: existingId },
        select: { id: true, brandId: true, name: true },
      });
      if (menu) return { ...menu, created: false };
    }

    const now = new Date();
    const menu = await this.prisma.$transaction(async (tx) => {
      const m = await tx.menu.create({
        data: {
          brandId: loc.brandId,
          locationId,
          name: "Shop",
          status: "PUBLISHED",
          publishedTo: ["POS"],
          lastPublishedAt: now,
        },
        select: { id: true, brandId: true, name: true },
      });
      await tx.menuChannelAssignment.upsert({
        where: {
          locationId_channel_brandId: { locationId, channel: "POS", brandId: loc.brandId },
        },
        create: {
          tenantId,
          menuId: m.id,
          locationId,
          brandId: loc.brandId,
          channel: "POS",
          publishedAt: now,
          createdBy: userId ?? null,
        },
        update: { menuId: m.id, publishedAt: now },
      });
      return m;
    });
    this.logger.log(`Created Shop menu ${menu.id} for location ${locationId}`);
    return { ...menu, created: true };
  }

  // ── Spreadsheet import ────────────────────────────────────────────────────

  /**
   * Build or update the catalogue from spreadsheet rows (parsed in the
   * browser). Matching, per variant: the same barcode updates that variant;
   * otherwise the same product name in this menu gains or updates a variant;
   * otherwise a new product is created. Nothing is ever deleted — a row that
   * is missing from the sheet is simply left alone.
   *
   * `dryRun` validates and reports what would happen without writing.
   */
  async importRows(args: {
    tenantId: string;
    locationId: string;
    userId: string;
    rows: Array<Record<string, unknown>>;
    dryRun?: boolean;
  }) {
    const { tenantId, locationId, userId } = args;
    if (!Array.isArray(args.rows) || args.rows.length === 0) {
      throw new BadRequestException("The sheet has no rows");
    }
    if (args.rows.length > IMPORT_MAX_ROWS) {
      throw new BadRequestException(`Send at most ${IMPORT_MAX_ROWS} rows at a time`);
    }
    await this.location(tenantId, locationId);
    const { products, errors } = normalizeImportRows(args.rows);
    const summary = {
      products: products.length,
      created: 0,
      updated: 0,
      variantsCreated: 0,
      variantsUpdated: 0,
      stockSet: 0,
      errors: [...errors] as ImportError[],
      menu: null as null | { id: string; name: string; created: boolean },
      dryRun: !!args.dryRun,
    };
    if (args.dryRun) return summary;

    const menu = await this.ensureShopMenu(tenantId, locationId, userId);
    summary.menu = { id: menu.id, name: menu.name, created: menu.created };
    const categoryIds = await this.categoryResolver(menu.id);

    for (const product of products) {
      try {
        const r = await this.importProduct({
          tenantId,
          locationId,
          userId,
          menuId: menu.id,
          brandId: menu.brandId,
          product,
          categoryId: await categoryIds(product.category),
        });
        if (r.created) summary.created++;
        else summary.updated++;
        summary.variantsCreated += r.variantsCreated;
        summary.variantsUpdated += r.variantsUpdated;
        summary.stockSet += r.stockSet;
      } catch (err) {
        const msg =
          err instanceof ConflictException || err instanceof BadRequestException
            ? err.message
            : "could not be saved";
        this.logger.warn(`Import of "${product.name}" failed: ${(err as Error).message}`);
        summary.errors.push({ row: product.variants[0]?.row ?? 0, message: `${product.name}: ${msg}` });
      }
    }
    return summary;
  }

  /** Find-or-create categories by name within the menu, memoised. */
  private async categoryResolver(menuId: string) {
    const existing = await this.prisma.menuCategory.findMany({
      where: { OR: [{ menuId }, { menuIds: { has: menuId } }] },
      select: { id: true, name: true, sortOrder: true },
    });
    const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c.id]));
    let nextSort = existing.reduce((m, c) => Math.max(m, c.sortOrder), -1) + 1;
    return async (name: string): Promise<string> => {
      const key = name.trim().toLowerCase();
      const hit = byName.get(key);
      if (hit) return hit;
      const c = await this.prisma.menuCategory.create({
        data: { menuId, menuIds: [menuId], name: name.trim(), sortOrder: nextSort++ },
        select: { id: true },
      });
      byName.set(key, c.id);
      return c.id;
    };
  }

  private async importProduct(args: {
    tenantId: string;
    locationId: string;
    userId: string;
    menuId: string;
    brandId: string;
    product: ImportProduct;
    categoryId: string;
  }) {
    const { tenantId, locationId, userId, menuId, brandId, product, categoryId } = args;
    const result = { created: false, variantsCreated: 0, variantsUpdated: 0, stockSet: 0 };

    // 1. Which product is this? A known barcode wins over a name match.
    const barcodes = product.variants.map((v) => v.barcode).filter(Boolean) as string[];
    const byBarcode = barcodes.length
      ? await this.prisma.productVariant.findMany({
          where: { brandId, barcode: { in: barcodes.flatMap(barcodeLookupKeys) } },
          select: { id: true, barcode: true, menuItemId: true },
        })
      : [];
    let menuItemId = byBarcode[0]?.menuItemId ?? null;
    if (!menuItemId) {
      const named = await this.prisma.menuItem.findFirst({
        where: {
          brandId,
          name: { equals: product.name, mode: "insensitive" },
          categories: { some: { category: { OR: [{ menuId }, { menuIds: { has: menuId } }] } } },
        },
        select: { id: true },
      });
      menuItemId = named?.id ?? null;
    }

    const single = product.variants.length === 1 && product.variants[0]!.variantName === "Default";
    const basePrice = Math.min(...product.variants.map((v) => v.price));

    if (!menuItemId) {
      const plu = await this.plu.generateUnique("product", tenantId);
      const item = await this.prisma.menuItem.create({
        data: {
          brandId,
          locationId,
          name: product.name,
          description: product.description,
          basePrice,
          plu,
          menuIds: [menuId],
        },
        select: { id: true },
      });
      menuItemId = item.id;
      result.created = true;
    } else if (single) {
      await this.prisma.menuItem.update({
        where: { id: menuItemId },
        data: {
          basePrice,
          ...(product.description ? { description: product.description } : {}),
        },
      });
    }
    // In the category (idempotent — the join's primary key is the pair).
    await this.prisma.menuItemOnCategory.createMany({
      data: [{ categoryId, itemId: menuItemId }],
      skipDuplicates: true,
    });

    // 2. Variants.
    const existing = await this.prisma.productVariant.findMany({
      where: { menuItemId },
      select: { id: true, name: true, barcode: true },
    });
    for (const row of product.variants) {
      const match =
        (row.barcode &&
          existing.find((e) => e.barcode && barcodeLookupKeys(row.barcode!).includes(e.barcode))) ||
        existing.find((e) => e.name.toLowerCase() === row.variantName.toLowerCase()) ||
        // A bare "Default" row updating a product that has exactly one
        // variant under another name is the same thing, not a second one.
        (single && existing.length === 1 ? existing[0] : undefined);
      const input: VariantInput = {
        name: row.variantName,
        options: row.options,
        barcode: row.barcode,
        ...(row.sku ? { sku: row.sku } : {}),
        // A single-variant product keeps its price on the item; a variant
        // only carries a price of its own when it differs from the base.
        price: single ? null : row.price,
        costPrice: row.costPrice,
      };
      let variantId: string;
      if (match) {
        variantId = (await this.updateVariant(tenantId, match.id, input)).id;
        result.variantsUpdated++;
      } else {
        variantId = (await this.createVariant(tenantId, menuItemId, input)).id;
        existing.push({ id: variantId, name: row.variantName, barcode: row.barcode });
        result.variantsCreated++;
      }
      if (row.stock !== null) {
        await this.stock.adjust({
          tenantId,
          locationId,
          variantId,
          userId,
          mode: "count",
          quantity: Math.max(0, row.stock),
          reason: "Imported from spreadsheet",
        });
        result.stockSet++;
      }
    }
    return result;
  }

  /** Give an existing product (no variant yet) its first, barcoded variant. */
  async ensureDefaultVariant(tenantId: string, menuItemId: string, input: VariantInput) {
    const count = await this.prisma.productVariant.count({ where: { menuItemId } });
    if (count > 0) throw new BadRequestException("This product already has variants");
    return this.createVariant(tenantId, menuItemId, { name: "Default", ...input });
  }
}

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// ── Phase AK — PLU generation service ───────────────────────────────────────
//
// Base44 used `prod_${Date.now()}` for products, `mg_${Date.now()}` for
// groups, and `mod_${Date.now()}` for options. That's collision-prone
// at scale (rapid imports can land in the same millisecond) and impossible
// to scan visually.
//
// New scheme — short, readable, tenant-unique:
//
//   PROD-XXXXXX   for menu items
//   SKU-XXXXXX    for product SKU variants
//   MG-XXXXXX     for modifier groups
//   MOD-XXXXXX    for modifier options
//
// where XXXXXX is six base36 chars derived from a 30-bit random source.
// 30 bits ≈ 1.07B values → birthday collision needs ~33k PLUs at one
// prefix before any conflict; we re-roll on collision so the practical
// limit is far higher. Per-tenant uniqueness is enforced by checking the
// existing row set before each insert (see `generateUnique`).

const PREFIXES = {
  product: "PROD-",
  sku: "SKU-",
  modifierGroup: "MG-",
  modifier: "MOD-",
} as const;

export type PluKind = keyof typeof PREFIXES;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // skip I, O, 0, 1 for legibility

/**
 * Single random PLU. Not unique-checked — callers should pass through
 * `generateUnique` to bounce off collisions, or use only for fresh
 * inserts where the caller already enforces uniqueness in the DB.
 */
export function randomPlu(kind: PluKind, length = 6): string {
  let suffix = "";
  for (let i = 0; i < length; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return PREFIXES[kind] + suffix;
}

@Injectable()
export class PluService {
  private readonly logger = new Logger(PluService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Single-PLU generation ────────────────────────────────────────────────

  /**
   * Generate a PLU that doesn't already exist on this entity's table
   * within the tenant. Retries up to N times on collision; throws if it
   * can't find a free one (effectively never at our scale).
   */
  async generateUnique(kind: PluKind, tenantId: string, maxAttempts = 20): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const candidate = randomPlu(kind);
      const taken = await this.pluExistsInTenant(kind, candidate, tenantId);
      if (!taken) return candidate;
      this.logger.debug(
        `PLU collision on attempt ${attempt} for ${kind}=${candidate} in tenant ${tenantId}; retrying`,
      );
    }
    throw new Error(
      `Failed to generate unique ${kind} PLU after ${maxAttempts} attempts — collision rate suggests a non-random source`,
    );
  }

  /**
   * Cheap uniqueness check across the right table (and only within the
   * tenant). PLU collisions across tenants are allowed — different
   * restaurants can both use "PROD-ABC123".
   */
  private async pluExistsInTenant(
    kind: PluKind,
    plu: string,
    tenantId: string,
  ): Promise<boolean> {
    switch (kind) {
      case "product": {
        const tenantBrandIds = await this.tenantBrandIds(tenantId);
        const hit = await this.prisma.menuItem.findFirst({
          where: { plu, brandId: { in: tenantBrandIds } },
          select: { id: true },
        });
        return !!hit;
      }
      case "modifierGroup": {
        const hit = await this.prisma.modifierGroup.findFirst({
          where: { plu, brand: { tenantId } },
          select: { id: true },
        });
        return !!hit;
      }
      case "modifier": {
        const hit = await this.prisma.modifierOption.findFirst({
          where: { plu, group: { brand: { tenantId } } },
          select: { id: true },
        });
        return !!hit;
      }
      case "sku": {
        // SKUs live inside MenuItem.productSkus JSON — we can't query by
        // exact match cheaply without a generated column. Use a soft
        // check: scan a small sample for the exact PLU.
        const tenantBrandIds = await this.tenantBrandIds(tenantId);
        const items = await this.prisma.menuItem.findMany({
          where: { brandId: { in: tenantBrandIds } },
          select: { productSkus: true },
        });
        for (const item of items) {
          const skus = (item.productSkus as Array<{ plu?: string }>) ?? [];
          if (skus.some((s) => s?.plu === plu)) return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  // ── Imported PLU preservation ────────────────────────────────────────────

  /**
   * Returns the PLU we should stamp on an imported entity:
   *   - if the platform-supplied PLU is non-empty → keep it as-is
   *   - otherwise generate a fresh tenant-unique one
   *
   * Used by every importer (Uber: external_data; Deliveroo: item.plu;
   * HubRise: ref || sku_ref).
   */
  async resolveImportedPlu(
    kind: PluKind,
    importedPlu: string | null | undefined,
    tenantId: string,
  ): Promise<string> {
    const trimmed = (importedPlu ?? "").trim();
    if (trimmed) return trimmed;
    return this.generateUnique(kind, tenantId);
  }

  // ── Bulk "Generate missing PLUs" — admin action ──────────────────────────

  /**
   * Backfill every MenuItem / ModifierGroup / ModifierOption in the tenant
   * that has a null/blank PLU. Returns a per-kind count of how many were
   * stamped. Idempotent — re-running over an already-stamped catalog is
   * a no-op.
   *
   * Uniqueness is preserved row-by-row (we generate, check, write). It is
   * O(N) on the tenant catalog; in practice the Menu Manager calls this
   * once per import. For very large catalogs (>10k items) consider
   * background queueing.
   */
  async generateMissingForTenant(tenantId: string): Promise<{
    products: number;
    modifierGroups: number;
    modifiers: number;
  }> {
    const result = { products: 0, modifierGroups: 0, modifiers: 0 };

    // Products
    const tenantBrandIds = await this.tenantBrandIds(tenantId);
    const itemsNeedingPlu = await this.prisma.menuItem.findMany({
      where: {
        OR: [{ plu: null }, { plu: "" }],
        brandId: { in: tenantBrandIds },
      },
      select: { id: true },
    });
    for (const { id } of itemsNeedingPlu) {
      const plu = await this.generateUnique("product", tenantId);
      await this.prisma.menuItem.update({ where: { id }, data: { plu } });
      result.products++;
    }

    // Modifier groups
    const groupsNeedingPlu = await this.prisma.modifierGroup.findMany({
      where: { OR: [{ plu: null }, { plu: "" }], brand: { tenantId } },
      select: { id: true },
    });
    for (const { id } of groupsNeedingPlu) {
      const plu = await this.generateUnique("modifierGroup", tenantId);
      await this.prisma.modifierGroup.update({ where: { id }, data: { plu } });
      result.modifierGroups++;
    }

    // Modifier options
    const optionsNeedingPlu = await this.prisma.modifierOption.findMany({
      where: { OR: [{ plu: null }, { plu: "" }], group: { brand: { tenantId } } },
      select: { id: true },
    });
    for (const { id } of optionsNeedingPlu) {
      const plu = await this.generateUnique("modifier", tenantId);
      await this.prisma.modifierOption.update({ where: { id }, data: { plu } });
      result.modifiers++;
    }

    this.logger.log(
      `Generated PLUs for tenant ${tenantId}: ` +
        `${result.products} products, ${result.modifierGroups} groups, ${result.modifiers} modifiers`,
    );
    return result;
  }

  /**
   * MenuItem has only a brandId FK with no Prisma relation — so we resolve
   * the tenant's brand IDs once per call. Memoize at the request level if
   * this turns into a hotspot.
   */
  private async tenantBrandIds(tenantId: string): Promise<string[]> {
    const brands = await this.prisma.brand.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true },
    });
    return brands.map((b) => b.id);
  }
}
